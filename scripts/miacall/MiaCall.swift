// MiaCall.app — Mia rings Daniel over FaceTime Audio from this Mac (task 0621).
//
// `mia call "…"` asks the relay for a call (POST /phone/call → id + stream key),
// then opens this app:  open -n -g MiaCall.app --args --call <id> --key <k> --to <+27…> --relay <https://…>
//   1. default input → BlackHole 2ch (FaceTime's mic = Mia's voice), restored after
//   2. facetime-audio://<number>, then presses the "Call" confirmation (Accessibility)
//   3. wss://relay/phone/stream: start {format:pcm16, wait:1} → ringing
//   4. answered (FaceTime shows a call timer) → "answered"; the relay starts the
//      OpenAI Realtime voice. Call audio: a Core Audio process tap (all processes but
//      this one, muted on the speakers) → 24 kHz PCM16 → relay; relay audio → BlackHole.
//   5. ends on: relay {event:hangup} (Mia's goodbye / 5 min cap), FaceTime call gone,
//      no answer within 45 s. Then "stop" {reason}, restore devices, quit.
// Other modes:  --check   ask for / report the permissions (Accessibility, audio capture)
//               --selftest  mock audio loop: tap hears a tone; BlackHole loops our audio
//               --dump      print FaceTime's accessibility tree (debugging the UI)
// Log + result: ~/.mission-control/mia/facetime/<id>.log / .json
import AppKit
import ApplicationServices
import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation

// MARK: - args, log
var opts: [String: String] = [:]
var flags = Set<String>()
do {
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        if ["--call", "--key", "--to", "--relay", "--ring-seconds"].contains(a) { opts[a] = it.next() ?? "" } else { flags.insert(a) }
    }
}
let dir = (NSHomeDirectory() as NSString).appendingPathComponent(".mission-control/mia/facetime")
try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
let tag = opts["--call"] ?? (flags.contains("--check") ? "check" : flags.contains("--selftest") ? "selftest" : flags.contains("--rehearse") ? "rehearse" : flags.contains("--say-test") ? "say-test" : "run")
let logPath = (dir as NSString).appendingPathComponent("\(tag).log")
FileManager.default.createFile(atPath: logPath, contents: nil)
let logFH = FileHandle(forWritingAtPath: logPath)
func log(_ s: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(s)\n"
    logFH?.write(line.data(using: .utf8)!)
    FileHandle.standardError.write(line.data(using: .utf8)!)
}
func writeResult(_ obj: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted]) {
        try? d.write(to: URL(fileURLWithPath: (dir as NSString).appendingPathComponent("\(tag).json")))
    }
}

// MARK: - Core Audio helpers
func prop(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}
func defaultDevice(input: Bool) -> AudioDeviceID {
    var a = prop(input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice)
    var id = AudioDeviceID(0); var sz = UInt32(MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &sz, &id)
    return id
}
@discardableResult func setDefaultInput(_ id: AudioDeviceID) -> OSStatus {
    var a = prop(kAudioHardwarePropertyDefaultInputDevice); var v = id
    return AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &v)
}
func deviceUID(_ id: AudioDeviceID) -> String {
    var a = prop(kAudioDevicePropertyDeviceUID); var s: Unmanaged<CFString>?; var sz = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &a, 0, nil, &sz, &s) == noErr, let v = s else { return "" }
    return v.takeRetainedValue() as String
}
func device(uid: String) -> AudioDeviceID? {
    var a = prop(kAudioHardwarePropertyDevices); var sz: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &sz)
    var ids = [AudioDeviceID](repeating: 0, count: Int(sz) / MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &sz, &ids)
    return ids.first { deviceUID($0) == uid }
}
func processObject(pid: pid_t) -> AudioObjectID {
    var a = prop(kAudioHardwarePropertyTranslatePIDToProcessObject); var p = pid
    var obj = AudioObjectID(0); var sz = UInt32(MemoryLayout<AudioObjectID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, UInt32(MemoryLayout<pid_t>.size), &p, &sz, &obj)
    return obj
}
let blackholeUID = ProcessInfo.processInfo.environment["MIA_CALL_LOOPBACK"] ?? "BlackHole2ch_UID"

// MARK: - capture: process tap (everything but us) → 24 kHz mono Int16
final class Capture {
    var tapID = AudioObjectID(0), aggID = AudioObjectID(0), proc: AudioDeviceIOProcID?
    var onPCM: (Data) -> Void = { _ in }
    var rms: Float = 0
    private var rate: Double = 48000, channels = 2, interleaved = true
    private var phase: Double = 0, acc = [Int16]()
    func start(excluding: [AudioObjectID]) -> String? {
        let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: excluding)
        desc.uuid = UUID()
        desc.name = "MiaCall"
        desc.isPrivate = true
        desc.muteBehavior = .mutedWhenTapped
        var st = AudioHardwareCreateProcessTap(desc, &tapID)
        if st != noErr { return "AudioHardwareCreateProcessTap \(st)" }
        var fa = prop(kAudioTapPropertyFormat); var asbd = AudioStreamBasicDescription(); var sz = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        AudioObjectGetPropertyData(tapID, &fa, 0, nil, &sz, &asbd)
        rate = asbd.mSampleRate > 0 ? asbd.mSampleRate : 48000
        channels = max(1, Int(asbd.mChannelsPerFrame))
        interleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0
        let outUID = deviceUID(defaultDevice(input: false))
        let agg: [String: Any] = [
            kAudioAggregateDeviceNameKey: "MiaCall Tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: desc.uuid.uuidString]],
        ]
        st = AudioHardwareCreateAggregateDevice(agg as CFDictionary, &aggID)
        if st != noErr { return "AudioHardwareCreateAggregateDevice \(st)" }
        let q = DispatchQueue(label: "miacall.capture")
        st = AudioDeviceCreateIOProcIDWithBlock(&proc, aggID, q) { [weak self] _, inData, _, _, _ in self?.ingest(inData) }
        if st != noErr { return "AudioDeviceCreateIOProcIDWithBlock \(st)" }
        st = AudioDeviceStart(aggID, proc)
        if st != noErr { return "AudioDeviceStart \(st)" }
        log("capture: tap \(Int(rate)) Hz × \(channels) \(interleaved ? "interleaved" : "planar"), main device \(outUID)")
        return nil
    }
    private func ingest(_ list: UnsafePointer<AudioBufferList>) {
        let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
        guard let first = abl.first, let p0 = first.mData else { return }
        var mono = [Float]()
        if interleaved {
            let n = Int(first.mDataByteSize) / 4 / channels
            let f = p0.assumingMemoryBound(to: Float.self)
            mono.reserveCapacity(n)
            for i in 0..<n { var s: Float = 0; for c in 0..<channels { s += f[i * channels + c] }; mono.append(s / Float(channels)) }
        } else {
            let n = Int(first.mDataByteSize) / 4
            mono = [Float](repeating: 0, count: n)
            for b in abl { guard let d = b.mData else { continue }; let f = d.assumingMemoryBound(to: Float.self); for i in 0..<n { mono[i] += f[i] / Float(abl.count) } }
        }
        var e: Float = 0; for s in mono { e += s * s }; if !mono.isEmpty { rms = sqrt(e / Float(mono.count)) }
        // resample to 24 kHz (linear)
        let step = rate / 24000
        while phase < Double(mono.count - 1) {
            let i = Int(phase), t = Float(phase - Double(i))
            let v = mono[i] * (1 - t) + mono[i + 1] * t
            acc.append(Int16(max(-1, min(1, v)) * 32767))
            phase += step
        }
        phase -= Double(max(0, mono.count - 1))
        if acc.count >= 960 { // 40 ms
            let d = acc.withUnsafeBufferPointer { Data(buffer: $0) }
            acc.removeAll(keepingCapacity: true)
            onPCM(d)
        }
    }
    func stop() {
        if let p = proc { AudioDeviceStop(aggID, p); AudioDeviceDestroyIOProcID(aggID, p) }
        if aggID != 0 { AudioHardwareDestroyAggregateDevice(aggID) }
        if tapID != 0 { AudioHardwareDestroyProcessTap(tapID) }
        proc = nil; aggID = 0; tapID = 0
    }
}

// MARK: - playback: 24 kHz PCM16 → BlackHole (FaceTime's microphone)
final class Player {
    let engine = AVAudioEngine(), node = AVAudioPlayerNode()
    let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
    func start(deviceID: AudioDeviceID) -> String? {
        guard let au = engine.outputNode.audioUnit else { return "no output unit" }
        var dev = deviceID
        let st = AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioDeviceID>.size))
        if st != noErr { return "set output device \(st)" }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: fmt)
        do { try engine.start() } catch { return "engine: \(error.localizedDescription)" }
        node.play()
        return nil
    }
    func play(pcm16 d: Data) {
        let n = d.count / 2
        guard n > 0, let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(n)) else { return }
        buf.frameLength = AVAudioFrameCount(n)
        d.withUnsafeBytes { raw in
            let s = raw.bindMemory(to: Int16.self)
            for i in 0..<n { buf.floatChannelData![0][i] = Float(Int16(littleEndian: s[i])) / 32768 }
        }
        node.scheduleBuffer(buf, completionHandler: nil)
    }
    func tone(seconds: Double, hz: Double = 440) {
        let n = Int(24000 * seconds)
        var d = Data(count: n * 2)
        d.withUnsafeMutableBytes { raw in
            let s = raw.bindMemory(to: Int16.self)
            for i in 0..<n { s[i] = Int16(sin(2 * .pi * hz * Double(i) / 24000) * 8000) }
        }
        play(pcm16: d)
    }
    func clear() { node.stop(); node.play() }
    func stop() { node.stop(); engine.stop() }
}

// MARK: - Accessibility (FaceTime UI)  — task 0624
// FaceTime's "Call" confirmation is often a window on ANOTHER Space (e.g. behind a
// full-screen terminal); AXWindows only lists the current Space's windows, so we
// also enumerate the app's windows by remote token (the AltTab technique), which
// reaches every Space. Walks are bounded (timeout, depth, node cap, the Recents
// list skipped) so one poll takes well under a second — 0621's walk of every
// Apple app took 60–80 s and made every state change late.
@_silgen_name("_AXUIElementCreateWithRemoteToken") func _AXCreateWithRemoteToken(_ data: CFData) -> Unmanaged<AXUIElement>?
func axAttr(_ e: AXUIElement, _ n: String) -> AnyObject? { var v: AnyObject?; return AXUIElementCopyAttributeValue(e, n as CFString, &v) == .success ? v : nil }
func axStr(_ e: AXUIElement, _ n: String) -> String { (axAttr(e, n) as? String) ?? ((axAttr(e, n) as? NSNumber)?.stringValue ?? "") }
func axActions(_ e: AXUIElement) -> [String] { var a: CFArray?; return AXUIElementCopyActionNames(e, &a) == .success ? ((a as? [String]) ?? []) : [] }
let FACETIME = "com.apple.FaceTime"
let UI_APPS = [FACETIME, "com.apple.notificationcenterui", "com.apple.UserNotificationCenter", "com.apple.TelephonyUtilities", "com.apple.InCallService"]
var exploreAll = false
struct Node { let app: String, win: String, role: String, title: String, desc: String, ident: String, value: String, actions: [String], el: AXUIElement
    var labels: [String] { [title, desc].map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty } }
}
func tokenWindows(pid: pid_t) -> [AXUIElement] {
    var out: [AXUIElement] = []
    var tok = Data(count: 20)
    tok.replaceSubrange(0..<4, with: withUnsafeBytes(of: pid) { Data($0) })
    tok.replaceSubrange(8..<12, with: withUnsafeBytes(of: Int32(0x636f636f)) { Data($0) })
    let t0 = Date()
    for id in UInt64(0)..<1200 {
        if Date().timeIntervalSince(t0) > 1.0 { log("window scan stopped at token \(id) (1 s budget)"); break }
        tok.replaceSubrange(12..<20, with: withUnsafeBytes(of: id) { Data($0) })
        guard let e = _AXCreateWithRemoteToken(tok as CFData)?.takeRetainedValue() else { continue }
        AXUIElementSetMessagingTimeout(e, 0.3)
        if axStr(e, kAXRoleAttribute) == "AXWindow" { out.append(e) }
    }
    return out
}
var tokenCache: (pid: pid_t, at: Date, wins: [AXUIElement])?
func uiRoots(crossSpace: Bool) -> [(String, AXUIElement)] {
    var out: [(String, AXUIElement)] = []
    let apps = exploreAll
        ? NSWorkspace.shared.runningApplications.filter { ($0.bundleIdentifier ?? "").hasPrefix("com.apple.") }
        : UI_APPS.flatMap { NSRunningApplication.runningApplications(withBundleIdentifier: $0) }
    for app in apps {
        let b = app.bundleIdentifier ?? "?", pid = app.processIdentifier
        let ax = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(ax, 0.8)
        var wins = (axAttr(ax, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        if crossSpace && b == FACETIME {
            if tokenCache == nil || tokenCache!.pid != pid || Date().timeIntervalSince(tokenCache!.at) > 2 {
                tokenCache = (pid, Date(), tokenWindows(pid: pid))
            }
            for w in tokenCache!.wins where !wins.contains(where: { CFEqual($0, w) }) { wins.append(w) }
        }
        for w in wins { out.append((b, w)) }
    }
    return out
}
func snapshot(crossSpace: Bool = true) -> [Node] {
    var nodes: [Node] = []
    for (b, w) in uiRoots(crossSpace: crossSpace) {
        let wt = axStr(w, kAXTitleAttribute)
        if b == "com.apple.notificationcenterui" && wt.hasPrefix("com.apple.") { continue } // desktop widgets (clock etc.)
        var count = 0
        func walk(_ e: AXUIElement, _ d: Int) {
            count += 1
            if count > 2500 || d > 30 { return }
            let id = axStr(e, kAXIdentifierAttribute)
            if id.hasPrefix("FaceTime.RecentsList") || id == "FTRecentsView" { return }
            let role = axStr(e, kAXRoleAttribute)
            nodes.append(Node(app: b, win: wt, role: role, title: axStr(e, kAXTitleAttribute), desc: axStr(e, kAXDescriptionAttribute), ident: id,
                              value: String(axStr(e, kAXValueAttribute).prefix(80)), actions: role == "AXStaticText" ? [] : axActions(e), el: e))
            for k in (axAttr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { walk(k, d + 1) }
        }
        walk(w, 0)
    }
    return nodes
}
func describe(_ n: Node) -> String {
    var l = [n.role, n.title, n.desc, n.ident, n.value].joined(separator: " | ")
    let acts = n.actions.filter { $0 != "AXShowMenu" && $0 != "AXScrollToVisible" }
    if !acts.isEmpty { l += " | actions: " + acts.map { $0.replacingOccurrences(of: "\n", with: " ") }.joined(separator: ", ") }
    return l
}
func dump(_ nodes: [Node]) -> String {
    var s = "", lastWin = ""
    for n in nodes {
        let w = "\(n.app) window: \(n.win)"
        if w != lastWin { s += "== \(w)\n"; lastWin = w }
        if !(n.title.isEmpty && n.desc.isEmpty && n.ident.isEmpty && n.value.isEmpty) { s += "  " + describe(n) + "\n" }
    }
    return s
}
func dumpUI() -> String { dump(snapshot()) }
// Buttons, by exact label (0621 matched substrings: "end" hit unrelated buttons).
// 0626: the confirmation (Notification Center, FACETIME_NOTIFICATION) holds an AvatarView
// labelled "FaceTime Audio" that also answers AXPress but does nothing. Only an AXButton
// titled/described exactly "Call" is pressed; fallback: the "<number>, Click to Call" element.
let CALL_LABELS: Set<String> = ["call"]
let END_LABELS: Set<String> = ["end", "end call", "leave", "leave call", "hang up", "cancel call"]
func isButton(_ n: Node) -> Bool { n.role == "AXButton" || n.role == "AXMenuItem" || n.actions.contains("AXPress") }
func callButtons(_ ns: [Node]) -> [Node] {
    func exact(_ n: Node) -> Bool { [n.title, n.desc].contains { $0.trimmingCharacters(in: .whitespaces) == "Call" } }
    let real = ns.filter { $0.role == "AXButton" && exact($0) && $0.ident != "AvatarView" }
    if !real.isEmpty { return real }
    return ns.filter { n in n.ident != "AvatarView" && n.actions.contains("AXPress") && n.labels.contains { $0.hasSuffix(", click to call") } }
}
/// Custom actions named "Call" (notification-style alerts expose buttons this way).
func callActions(_ ns: [Node]) -> [(Node, String)] {
    var out: [(Node, String)] = []
    for n in ns { for a in n.actions where a.hasPrefix("Name:") {
        let name = a.dropFirst(5).split(separator: "\n").first.map(String.init)?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        if CALL_LABELS.contains(name) { out.append((n, a)) }
    } }
    return out
}
func endButtons(_ ns: [Node]) -> [Node] {
    ns.filter { n in isButton(n) && (n.labels.contains { END_LABELS.contains($0) || $0.hasPrefix("end ") } || ["endcall", "hangup", "endbutton", "leavebutton"].contains(n.ident.lowercased())) }
}
/// Windows that hold an End button: the call UI. Timers/status text only count there
/// (or in FaceTime itself), so a clock or a notification timestamp is never "connected".
func callWindows(_ ns: [Node]) -> Set<String> { Set(endButtons(ns).map { $0.app + "\u{1}" + $0.win }) }
func inCallUI(_ n: Node, _ w: Set<String>) -> Bool { n.app == FACETIME || n.app.contains("Telephony") || n.app.contains("InCall") || w.contains(n.app + "\u{1}" + n.win) }
func cancelButtons(_ ns: [Node]) -> [Node] { ns.filter { n in isButton(n) && n.labels.contains("cancel") } }
let timerRx = try! NSRegularExpression(pattern: "^\\d{1,2}:\\d{2}(:\\d{2})?$")
// 0628: FaceTime folds the timer into the call element's label:
// "+27 (83) 561-5106, facetime audio - , 0:11". Bidi marks (U+202A…) are stripped first.
let labelTimerRx = try! NSRegularExpression(pattern: ",\\s*-?\\s*,?\\s*(\\d{1,2}:\\d{2}(:\\d{2})?)\\s*$")
func clean(_ s: String) -> String {
    String(s.unicodeScalars.filter { !(0x200E...0x200F).contains($0.value) && !(0x202A...0x202E).contains($0.value) && !(0x2066...0x2069).contains($0.value) }).trimmingCharacters(in: .whitespaces)
}
/// (timer, fromLabel): a standalone m:ss, or a trailing ", m:ss" inside a call element label.
func timerInfo(_ ns: [Node]) -> (String, Bool)? {
    let w = callWindows(ns)
    for n in ns where inCallUI(n, w) {
        for s in [n.value, n.title, n.desc] {
            let t = clean(s); if t.isEmpty { continue }
            let r = NSRange(t.startIndex..., in: t)
            if timerRx.firstMatch(in: t, range: r) != nil { return (t, false) }
            if let m = labelTimerRx.firstMatch(in: t, range: r), let g = Range(m.range(at: 1), in: t) { return (String(t[g]), true) }
        }
    }
    return nil
}
func timerText(_ ns: [Node]) -> String? { timerInfo(ns)?.0 }
let RINGING_WORDS = ["calling", "ringing", "connecting", "waiting"]
func ringingText(_ ns: [Node]) -> String? {
    let w = callWindows(ns)
    for n in ns where inCallUI(n, w) { for s in [n.value, n.title, n.desc] {
        let l = clean(s).lowercased()
        if RINGING_WORDS.contains(where: { l.hasPrefix($0) || l.contains(" \($0)") }) { return s }
        // 0628: while ringing the call element reads "<number>, facetime audio…"
        if l.contains(",") && (l.hasSuffix("…") || l.hasSuffix("...")) { return s }
    } }
    return nil
}
/// In-call controls (keypad + mute + end) are up.
func inCallControls(_ ns: [Node]) -> Bool {
    let w = callWindows(ns); if w.isEmpty { return false }
    let ls = Set(ns.filter { isButton($0) && inCallUI($0, w) }.flatMap { $0.labels })
    return ls.contains("keypad") && ls.contains("mute")
}
/// "<number> left": the other side hung up (FaceTime banner/notification).
func leftText(_ ns: [Node]) -> String? {
    for n in ns where n.app == FACETIME || n.app.contains("notificationcenterui") || n.app == "com.apple.UserNotificationCenter" || n.app.contains("InCall") {
        for s in [n.value, n.title, n.desc] {
            let l = clean(s).lowercased()
            guard l.hasSuffix(" left"), l.count > 6, !["minute", "second", "hour", "battery", "day"].contains(where: { l.contains($0) }) else { continue }
            if l.rangeOfCharacter(from: .decimalDigits) != nil || n.app == FACETIME { return clean(s) }
        }
    }
    return nil
}
func axPress(_ n: Node, _ why: String) -> Bool {
    let r = AXUIElementPerformAction(n.el, kAXPressAction as CFString)
    log("pressed \(why): \(describe(n)) → \(r.rawValue)")
    return r == .success
}
/// Compact one-line view of the call UI, logged whenever it changes.
func signature(_ ns: [Node]) -> String {
    var parts: [String] = []
    for n in ns where n.app == FACETIME || n.app.contains("Telephony") || n.app.contains("InCall") || n.app == "com.apple.UserNotificationCenter" || (n.app == "com.apple.notificationcenterui" && !n.win.hasPrefix("com.apple.")) {
        if isButton(n), let l = n.labels.first, !["filter", "new", "change background", "portrait"].contains(l) { parts.append("[\(l)]") }
        else if n.role == "AXStaticText", !n.value.isEmpty { parts.append("\"\(n.value.prefix(30))\"") }
    }
    return parts.isEmpty ? "(no call UI)" : parts.joined(separator: " ")
}
/// Bring FaceTime (and its Space) forward: AXFrontmost + raise every window, plus a LaunchServices activation.
func bringFaceTimeForward() {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: FACETIME).first else { return }
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetAttributeValue(ax, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    for w in tokenWindows(pid: app.processIdentifier) { AXUIElementPerformAction(w, kAXRaiseAction as CFString) }
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: FACETIME) {
        let c = NSWorkspace.OpenConfiguration(); c.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: c, completionHandler: nil)
    }
    app.activate()
    log("brought FaceTime forward (frontmost: \(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?"))")
}
/// Last resort: Return (the dialog's default button) sent straight to FaceTime's process.
func sendReturnToFaceTime() {
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: FACETIME).first else { return }
    let src = CGEventSource(stateID: .hidSystemState)
    for down in [true, false] { CGEvent(keyboardEventSource: src, virtualKey: 36, keyDown: down)?.postToPid(app.processIdentifier) }
    log("sent Return to FaceTime (pid \(app.processIdentifier))")
}

// MARK: - modes
func checkPermissions(prompt: Bool) -> [String: Any] {
    let ax = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary)
    var res: [String: Any] = ["accessibility": ax, "blackhole": device(uid: blackholeUID) != nil]
    let cap = Capture()
    let err = cap.start(excluding: [])
    Thread.sleep(forTimeInterval: 0.6)
    cap.stop()
    res["audioCapture"] = err == nil
    if let e = err { res["audioCaptureError"] = e }
    return res
}

func selftest() -> Int32 {
    var ok = true
    guard let bh = device(uid: blackholeUID) else { log("selftest: BlackHole 2ch not found"); return 2 }
    // 1. the tap hears other processes (afplay), muted on the speakers
    let player = Player()
    if let e = player.start(deviceID: bh) { log("selftest: player: \(e)"); return 1 }
    player.tone(seconds: 0.2) // makes our own process object exist
    Thread.sleep(forTimeInterval: 0.3)
    let me = processObject(pid: getpid())
    let cap = Capture()
    var heard: Float = 0, frames = 0
    cap.onPCM = { d in frames += d.count / 2; d.withUnsafeBytes { r in for s in r.bindMemory(to: Int16.self) { heard = max(heard, abs(Float(s)) / 32768) } } }
    if let e = cap.start(excluding: me != 0 ? [me] : []) { log("selftest: capture failed: \(e)"); return 1 }
    let tone = Process(); tone.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
    tone.arguments = ["/System/Library/Sounds/Ping.aiff"]
    try? tone.run(); tone.waitUntilExit()
    Thread.sleep(forTimeInterval: 0.3)
    log(String(format: "selftest: tap → %d frames at 24 kHz, peak %.3f while afplay pinged", frames, heard))
    if heard < 0.01 { ok = false; log("selftest: FAIL tap heard nothing (audio capture not allowed?)") }
    // 2. our own audio (to BlackHole) is NOT in the tap (no echo into the call)
    heard = 0
    player.tone(seconds: 0.8)
    Thread.sleep(forTimeInterval: 1.0)
    log(String(format: "selftest: own tone to BlackHole → tap peak %.3f (want ~0)", heard))
    if heard > 0.05 { ok = false; log("selftest: FAIL our own voice leaks into the capture") }
    cap.stop()
    // 3. BlackHole loops what we play to its input (what FaceTime will hear)
    var loop: Float = 0
    let rec = AVAudioEngine()
    if let au = rec.inputNode.audioUnit {
        var dev = bh
        AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioDeviceID>.size))
        let f = rec.inputNode.outputFormat(forBus: 0)
        rec.inputNode.installTap(onBus: 0, bufferSize: 1024, format: f) { b, _ in
            guard let c = b.floatChannelData else { return }
            for i in 0..<Int(b.frameLength) { loop = max(loop, abs(c[0][i])) }
        }
        do { try rec.start() } catch { log("selftest: BlackHole input: \(error)") }
        player.tone(seconds: 0.8, hz: 660)
        Thread.sleep(forTimeInterval: 1.2)
        rec.stop()
    }
    log(String(format: "selftest: BlackHole loopback peak %.3f", loop))
    if loop < 0.05 { ok = false; log("selftest: FAIL nothing came back through BlackHole") }
    player.stop()
    log("selftest: \(ok ? "PASS" : "FAIL")")
    return ok ? 0 : 1
}

// MARK: - local TTS (fallback voice; also the --say-test)
func sayPCM16(_ text: String) -> Data? {
    let f = NSTemporaryDirectory() + "miacall-say-\(getpid()).wav"
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    p.arguments = ["--file-format=WAVE", "--data-format=LEI16@24000", "-o", f, text]
    do { try p.run() } catch { return nil }
    p.waitUntilExit()
    defer { try? FileManager.default.removeItem(atPath: f) }
    guard let d = FileManager.default.contents(atPath: f), d.count > 44 else { return nil }
    // find the "data" chunk
    var i = 12
    while i + 8 <= d.count {
        let id = String(data: d[i..<i + 4], encoding: .ascii) ?? ""
        let sz = Int(d[i + 4]) | Int(d[i + 5]) << 8 | Int(d[i + 6]) << 16 | Int(d[i + 7]) << 24
        if id == "data" { return d.subdata(in: (i + 8)..<min(d.count, i + 8 + sz)) }
        i += 8 + sz
    }
    return nil
}

// MARK: - the call
// All call state lives on one serial queue (axq); the main thread only runs the app.
let axq = DispatchQueue(label: "miacall.ax")
final class Call {
    let id: String, key: String, to: String, relay: URL?
    var ws: URLSessionWebSocketTask?, wsOpen = false, sendErrors = 0
    let player = Player(), cap = Capture()
    var prevInput = AudioDeviceID(0)
    var state = "starting", answeredAt: Date?, ringingAt: Date?, ended = false
    let launchedAt = Date(), ringSeconds: Double, rehearsal: Bool
    var lastPressAt = Date.distantPast, sawConfirm = false
    var lastSig = "", confirmPresses = 0, broughtForward = false, sentReturn = false
    var sawCallUI = false, sawRingingText = false, noUITicks = 0, quietUITicks = 0, timerSeen: String?
    var mediaIn = 0, mediaBytes = 0, firstMediaAt: Date?, fallbackSpoken = false, lastStats = Date(), speechUntil = Date.distantPast
    init(id: String, key: String, to: String, relay: URL?, rehearsal: Bool) {
        self.id = id; self.key = key; self.to = to; self.relay = relay; self.rehearsal = rehearsal
        ringSeconds = Double(opts["--ring-seconds"] ?? "") ?? 60
    }
    func send(_ obj: [String: Any]) {
        guard let ws = ws, wsOpen else { return }
        guard let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
        ws.send(.string(s)) { [weak self] e in
            guard let e = e, let self = self else { return }
            self.sendErrors += 1
            if self.sendErrors <= 3 { log("ws send: \(e.localizedDescription)") }
        }
    }
    func receive() {
        ws?.receive { [weak self] r in
            guard let self = self else { return }
            switch r {
            case .failure(let e):
                axq.async {
                    guard self.wsOpen else { return }
                    self.wsOpen = false
                    log("ws closed: \(e.localizedDescription) (state \(self.state))")
                    if self.state == "live" && !self.ended && !self.fallbackSpoken { self.speakFallback("Sorry Daniel, I lost my connection. I'll message you instead.") }
                    self.finish("completed", "relay closed", after: self.state == "live" ? 0.8 : 0)
                }
            case .success(let m):
                if case .string(let s) = m, let d = s.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                    switch o["event"] as? String ?? "" {
                    case "media":
                        if let p = (o["media"] as? [String: Any])?["payload"] as? String, let a = Data(base64Encoded: p) {
                            self.player.play(pcm16: a)
                            axq.async {
                                self.mediaIn += 1; self.mediaBytes += a.count
                                if self.firstMediaAt == nil { self.firstMediaAt = Date(); log("relay audio: first chunk → BlackHole (\(String(format: "%.1f", self.answeredAt.map { Date().timeIntervalSince($0) } ?? -1)) s after answer)") }
                            }
                        }
                    case "clear": self.player.clear()
                    case "hangup":
                        let why = o["reason"] as? String ?? "hangup"
                        axq.async {
                            log("relay: hangup (\(why)) in state \(self.state)")
                            if self.state == "live" && why == "never connected" {
                                // The relay's dial timer raced the answer: say so rather than going silent.
                                self.speakFallback("Hi Daniel, it's Mia. My voice line timed out just as you answered. I'll message you instead.")
                                self.finish("completed", "relay gave up as he answered", after: 0.8)
                            } else {
                                // The relay ended a live call before Mia's voice ever arrived (0629: voice
                                // provider out of credits): say so before hanging up, never a silent drop.
                                if self.state == "live" && self.mediaIn == 0 && !self.fallbackSpoken {
                                    self.speakFallback("Sorry Daniel, my voice line isn't working right now. I'll message you instead.")
                                }
                                self.finish("completed", why, after: 0.8)
                            }
                        }
                    default: break
                    }
                }
                self.receive()
            }
        }
    }
    func start() -> String? {
        guard let bh = device(uid: blackholeUID) else { return "BlackHole 2ch is not installed" }
        if !AXIsProcessTrusted() { return "MiaCall has no Accessibility permission (System Settings › Privacy & Security › Accessibility)" }
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.0)
        if let e = player.start(deviceID: bh) { return "player: \(e)" }
        player.tone(seconds: 0.05, hz: 1) // our process object, so the tap can exclude us
        prevInput = defaultDevice(input: true)
        if prevInput == bh, let mic = ProcessInfo.processInfo.environment["MIA_CALL_RESTORE_INPUT"].flatMap({ device(uid: $0) }) ?? device(uid: "BuiltInMicrophoneDevice") { prevInput = mic }
        setDefaultInput(bh)
        log("default input → BlackHole (was \(deviceUID(prevInput))); now \(deviceUID(defaultDevice(input: true)))")
        if let relay = relay {
            var comps = URLComponents(url: relay, resolvingAgainstBaseURL: false)!
            comps.scheme = comps.scheme == "http" ? "ws" : "wss"; comps.path = "/phone/stream"
            ws = URLSession.shared.webSocketTask(with: comps.url!)
            wsOpen = true
            ws?.resume(); receive()
            send(["event": "start", "start": ["streamSid": "ft-\(id)", "customParameters": ["call": id, "key": key, "format": "pcm16", "wait": "1"]]])
        } else { log("rehearsal: no relay; dialling \(to) (a number nobody answers)") }
        // A confirmation left over from an earlier attempt would be pressed instead of ours.
        let pre = snapshot()
        let stale = Set(callButtons(pre).map { $0.win })
        for c in cancelButtons(pre) where stale.contains(c.win) { _ = axPress(c, "Cancel on a stale confirmation") }
        log("UI before dialling: \(signature(pre))")
        NSWorkspace.shared.open(URL(string: "facetime-audio://\(to)")!)
        log("dialling FaceTime Audio \(to.prefix(4))…")
        state = "confirm"
        axq.asyncAfter(deadline: .now() + 0.4) { self.tick() }
        return nil
    }
    var stateAt = Date()
    func go(_ s: String, _ why: String) { log("state \(state) → \(s) (\(why))"); state = s; stateAt = Date() }
    func tick() {
        if ended { return }
        let t0 = Date()
        let ns = snapshot()
        let took = Date().timeIntervalSince(t0)
        if took > 1.5 { log(String(format: "slow UI poll: %.1f s (%d elements)", took, ns.count)) }
        let sig = signature(ns)
        if sig != lastSig { log("UI[\(state)]: \(sig)"); lastSig = sig }
        let inState = Date().timeIntervalSince(stateAt), sinceLaunch = Date().timeIntervalSince(launchedAt)
        let ends = endButtons(ns), timer = timerText(ns), ringing = ringingText(ns)
        switch state {
        case "confirm":
            let calls = callButtons(ns), acts = callActions(ns)
            if !calls.isEmpty || !acts.isEmpty { if !sawConfirm { log("Call confirmation found: \((calls.first.map(describe) ?? acts.first.map { describe($0.0) }) ?? "")") }; sawConfirm = true }
            if !ends.isEmpty || timer != nil {
                go("ringing", confirmPresses == 0 ? "call UI up without a confirmation" : "call UI up after \(confirmPresses) press(es)")
                ringingAt = Date(); send(["event": "ringing"])
                if !broughtForward { bringFaceTimeForward(); broughtForward = true } // so its call window is on this Space
            } else if sawConfirm && confirmPresses > 0 && calls.isEmpty && acts.isEmpty && Date().timeIntervalSince(lastPressAt) > 1.4 {
                go("ringing", "confirmation gone after \(confirmPresses) press(es); no End button seen yet")
                ringingAt = Date(); send(["event": "ringing"])
                if !broughtForward { bringFaceTimeForward(); broughtForward = true }
            } else if Date().timeIntervalSince(lastPressAt) < 1.4 {
                // just pressed: give the dialog a moment to go away
            } else if let b = calls.first, confirmPresses < 6 {
                confirmPresses += 1; lastPressAt = Date()
                if !axPress(b, "Call (try \(confirmPresses))"), let a = callActions([b]).first { AXUIElementPerformAction(a.0.el, a.1 as CFString) }
            } else if let (n, a) = acts.first, confirmPresses < 6 {
                confirmPresses += 1; lastPressAt = Date()
                let r = AXUIElementPerformAction(n.el, a as CFString); log("performed action \(a.debugDescription) on \(describe(n)) → \(r.rawValue)")
            } else if inState > 2.5 && !broughtForward {
                log("no Call button yet; bringing FaceTime to this Space. UI:\n\(dump(ns))"); bringFaceTimeForward(); broughtForward = true
            } else if inState > 7 && !sentReturn && NSWorkspace.shared.frontmostApplication?.bundleIdentifier == FACETIME {
                sentReturn = true; lastPressAt = Date(); confirmPresses += 1; sendReturnToFaceTime()
            } else if inState > 15 {
                log("no Call confirmation found; UI:\n\(dump(ns))"); return finish("failed", "could not start the FaceTime call")
            }
        case "ringing":
            if !ends.isEmpty || timer != nil { sawCallUI = true; noUITicks = 0 } else { noUITicks += 1 }
            if ringing != nil { if !sawRingingText { log("ringing text: \"\(ringing!)\"") }; sawRingingText = true }
            // Connected = a call timer that is up in two polls in a row, or the
            // "Calling…" text gone while End stays (Daniel→Daniel calls show no name).
            if let left = leftText(ns) { log("'\(left)' while ringing"); return finish("completed", "Daniel left the call") }
            if let (tm, inLabel) = timerInfo(ns) {
                if timerSeen != nil || tm != "0:00" && tm != "00:00" || inLabel && !ends.isEmpty { return connected("call timer \(tm)\(inLabel ? " (in label)" : "")") }
                timerSeen = tm
            } else { timerSeen = nil }
            if ringing == nil && !ends.isEmpty && (sawRingingText || inCallControls(ns)) { quietUITicks += 1 } else { quietUITicks = 0 }
            if quietUITicks >= 3 { return connected(sawRingingText ? "'calling' text gone, End still there" : "keypad/mute/end up, no 'calling' text") }
            let deadline = min(ringSeconds, 85 - (ringingAt.map { $0.timeIntervalSince(launchedAt) } ?? 0)) // relay gives up at 90 s
            if inState > deadline {
                log("no answer after \(Int(inState)) s; UI:\n\(dump(ns))"); return finish("no-answer", "rang \(Int(inState)) s")
            }
            if sawCallUI && noUITicks >= 4 {
                log("call UI gone while ringing; UI:\n\(dump(ns))"); return finish("no-answer", "declined or unavailable")
            }
            if Int(inState) % 10 == 0 && inState - Double(Int(inState)) < 0.7 { log("ringing \(Int(inState)) s, launch +\(Int(sinceLaunch)) s") }
        case "live":
            if !ends.isEmpty || timer != nil { noUITicks = 0 } else { noUITicks += 1 }
            if noUITicks == 1 { log("call UI not seen (1); UI: \(sig)") }
            if let left = leftText(ns) { log("'\(left)'"); return finish("completed", "Daniel hung up") }
            if noUITicks >= 7 { log("FaceTime call ended; UI:\n\(dump(ns))"); return finish("completed", "Daniel hung up") }
            if !rehearsal && firstMediaAt == nil && inState > 8 && !fallbackSpoken {
                log("no audio from the relay 8 s after answering: local voice"); speakFallback("Hi Daniel, it's Mia. One moment, I'm connecting.")
            }
            if Date().timeIntervalSince(lastStats) >= 5 {
                lastStats = Date()
                log(String(format: "live %d s: timer %@, relay audio %d chunks / %.1f s, call audio rms %.4f", Int(inState), timer ?? "-", mediaIn, Double(mediaBytes) / 48000, cap.rms))
            }
            if rehearsal && inState > 10 { return finish("completed", "rehearsal done") }
            if inState > 330 { return finish("completed", "time cap (Mac)") }
        default: break
        }
        axq.asyncAfter(deadline: .now() + 0.7) { self.tick() }
    }
    func connected(_ why: String) {
        go("live", why); answeredAt = Date(); log("answered (\(why))")
        let me = processObject(pid: getpid())
        cap.onPCM = { [weak self] d in self?.send(["event": "media", "media": ["payload": d.base64EncodedString()]]) }
        if let e = cap.start(excluding: me != 0 ? [me] : []) { log("capture failed: \(e)"); return finish("failed", "no audio capture permission") }
        send(["event": "answered"])
        if rehearsal { speakFallback("This is Mia's rehearsal call.") }
        axq.asyncAfter(deadline: .now() + 0.7) { self.tick() }
    }
    func speakFallback(_ text: String) {
        fallbackSpoken = true
        if let d = sayPCM16(text) {
            player.play(pcm16: d)
            // Queued after anything already playing; finish() waits for it (+1 s).
            speechUntil = max(speechUntil, Date()).addingTimeInterval(Double(d.count) / 48000)
            log("local voice → BlackHole: \"\(text)\" (\(String(format: "%.1f", Double(d.count) / 48000)) s)")
        } else { log("local voice failed (say)") }
    }
    func finish(_ reason: String, _ detail: String, after: Double = 0) {
        if ended { return }
        ended = true
        log("ending: \(reason) (\(detail))\(after > 0 ? " in \(after) s" : "")")
        let t0 = Date()
        func whenQuiet(_ body: @escaping () -> Void) {
            // Never press End over Mia's local line: wait for it to finish, plus 1 s (max 15 s).
            let left = speechUntil.addingTimeInterval(1).timeIntervalSinceNow
            if left > 0 && Date().timeIntervalSince(t0) < 15 {
                axq.asyncAfter(deadline: .now() + min(left, 15)) { whenQuiet(body) }
            } else { body() }
        }
        axq.asyncAfter(deadline: .now() + after) { whenQuiet {
            if self.speechUntil > t0 { log("local voice done; pressing End") }
            if let e = endButtons(snapshot()).first { _ = axPress(e, "End") }
            else if let c = cancelButtons(snapshot()).first { _ = axPress(c, "Cancel") }
            self.send(["event": "stop", "stop": ["reason": reason, "detail": detail]])
            self.cap.stop()
            axq.asyncAfter(deadline: .now() + 0.6) {
                self.player.stop()
                if self.prevInput != 0 { setDefaultInput(self.prevInput); log("default input restored → \(deviceUID(defaultDevice(input: true)))") }
                self.wsOpen = false
                self.ws?.cancel(with: .normalClosure, reason: nil)
                writeResult(["id": self.id, "reason": reason, "detail": detail, "seconds": self.answeredAt.map { Int(Date().timeIntervalSince($0)) } ?? 0, "state": self.state])
                exit(reason == "failed" ? 1 : 0)
            }
        } }
    }
}

// MARK: - main
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
if flags.contains("--check") {
    let r = checkPermissions(prompt: true)
    log("check: \(r)"); writeResult(r)
    exit(((r["accessibility"] as? Bool) == true && (r["audioCapture"] as? Bool) == true && (r["blackhole"] as? Bool) == true) ? 0 : 1)
}
if flags.contains("--selftest") { exit(selftest()) }
if flags.contains("--dump") {
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.0)
    exploreAll = flags.contains("--all")
    let t0 = Date(); let ns = snapshot()
    log(String(format: "dump (%.2f s, %d elements, trusted %@):\n", Date().timeIntervalSince(t0), ns.count, AXIsProcessTrusted() ? "yes" : "NO") + dump(ns) + "signature: \(signature(ns))")
    exit(0)
}
if flags.contains("--say-test") {
    // Mia's local voice into BlackHole, nothing dialled.
    guard let bh = device(uid: blackholeUID) else { log("say-test: no BlackHole"); exit(2) }
    let p = Player(); if let e = p.start(deviceID: bh) { log("say-test: \(e)"); exit(1) }
    guard let d = sayPCM16("Hi Daniel, it's Mia. This is a test of my voice.") else { log("say-test: say failed"); exit(1) }
    p.play(pcm16: d); log(String(format: "say-test: played %.1f s of TTS into BlackHole", Double(d.count) / 48000))
    Thread.sleep(forTimeInterval: Double(d.count) / 48000 + 0.5); exit(0)
}
if flags.contains("--rehearse") {
    // Dry run: dial a fictional number (nobody rings), press Call, log every UI state, hang up.
    let to = opts["--to"] ?? "+15555550123"
    let call = Call(id: "rehearsal", key: "", to: to, relay: nil, rehearsal: true)
    axq.async { if let e = call.start() { log("cannot rehearse: \(e)"); exit(1) } }
    DispatchQueue.main.asyncAfter(deadline: .now() + 120) { axq.async { call.finish("completed", "watchdog") } }
    app.run()
}
guard let id = opts["--call"], let key = opts["--key"], let to = opts["--to"], let r = opts["--relay"], let relay = URL(string: r) else {
    log("usage: MiaCall --call <id> --key <k> --to <+27…> --relay <url> | --check | --selftest | --dump [--all] | --say-test | --rehearse [--to N]"); exit(2)
}
let call = Call(id: id, key: key, to: to, relay: relay, rehearsal: false)
axq.async { if let e = call.start() { log("cannot call: \(e)"); writeResult(["id": id, "reason": "failed", "detail": e]); exit(1) } }
// Safety net: never outlive the cap by much.
DispatchQueue.main.asyncAfter(deadline: .now() + 420) { axq.async { call.finish("completed", "watchdog") } }
app.run()
