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
let tag = opts["--call"] ?? (flags.contains("--check") ? "check" : flags.contains("--selftest") ? "selftest" : "run")
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

// MARK: - Accessibility (FaceTime UI)
func axAttr(_ e: AXUIElement, _ n: String) -> AnyObject? { var v: AnyObject?; return AXUIElementCopyAttributeValue(e, n as CFString, &v) == .success ? v : nil }
func axStr(_ e: AXUIElement, _ n: String) -> String { (axAttr(e, n) as? String) ?? ((axAttr(e, n) as? NSNumber)?.stringValue ?? "") }
func axWalk(_ e: AXUIElement, _ d: Int = 0, _ visit: (AXUIElement) -> Bool) -> Bool {
    if visit(e) { return true }
    if d > 40 { return false }
    for k in (axAttr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] where axWalk(k, d + 1, visit) { return true }
    return false
}
let UI_APPS = ["com.apple.FaceTime", "com.apple.notificationcenterui", "com.apple.TelephonyUtilities", "com.apple.InCallService", "com.apple.UserNotificationCenter"]
func uiRoots() -> [(String, AXUIElement)] {
    var out: [(String, AXUIElement)] = []
    for b in UI_APPS { for app in NSRunningApplication.runningApplications(withBundleIdentifier: b) {
        let ax = AXUIElementCreateApplication(app.processIdentifier); AXUIElementSetMessagingTimeout(ax, 2)
        for w in (axAttr(ax, kAXWindowsAttribute) as? [AXUIElement]) ?? [] { out.append((b, w)) }
    } }
    return out
}
func label(_ e: AXUIElement) -> [String] { [kAXTitleAttribute, kAXDescriptionAttribute, kAXIdentifierAttribute].map { axStr(e, $0).lowercased() } }
func findButton(_ names: [String]) -> AXUIElement? {
    var hit: AXUIElement?
    for (_, w) in uiRoots() where hit == nil {
        _ = axWalk(w) { e in
            let r = axStr(e, kAXRoleAttribute)
            guard r == "AXButton" || r == "AXMenuItem" else { return false }
            let l = label(e)
            if names.contains(where: { n in l.contains(n) }) { hit = e; return true }
            return false
        }
    }
    return hit
}
func press(_ names: [String]) -> Bool {
    guard let b = findButton(names) else { return false }
    let r = AXUIElementPerformAction(b, kAXPressAction as CFString)
    log("pressed \(names.first ?? "") (\(r.rawValue))")
    return true
}
func texts() -> [String] {
    var out: [String] = []
    for (_, w) in uiRoots() { _ = axWalk(w) { e in
        if axStr(e, kAXRoleAttribute) == "AXStaticText" { out.append(axStr(e, kAXValueAttribute)) }
        return false
    } }
    return out
}
func dumpUI() -> String {
    var s = ""
    for (b, w) in uiRoots() {
        s += "== \(b) window: \(axStr(w, kAXTitleAttribute))\n"
        _ = axWalk(w) { e in
            let l = [axStr(e, kAXRoleAttribute), axStr(e, kAXTitleAttribute), axStr(e, kAXDescriptionAttribute), axStr(e, kAXIdentifierAttribute), String(axStr(e, kAXValueAttribute).prefix(60))]
            if !(l[1].isEmpty && l[2].isEmpty && l[3].isEmpty && l[4].isEmpty) { s += "  " + l.joined(separator: " | ") + "\n" }
            return false
        }
    }
    return s
}
let timerRx = try! NSRegularExpression(pattern: "^\\d{1,2}:\\d{2}(:\\d{2})?$")
func callTimerVisible() -> Bool { texts().contains { timerRx.firstMatch(in: $0, range: NSRange($0.startIndex..., in: $0)) != nil } }

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

// MARK: - the call
final class Call {
    let id: String, key: String, to: String, relay: URL
    var ws: URLSessionWebSocketTask?
    let player = Player(), cap = Capture()
    var prevInput = AudioDeviceID(0)
    var state = "starting", answeredAt: Date?, startedAt = Date(), ended = false
    let ringSeconds: Double
    init(id: String, key: String, to: String, relay: URL) {
        self.id = id; self.key = key; self.to = to; self.relay = relay
        ringSeconds = Double(opts["--ring-seconds"] ?? "") ?? 45
    }
    func send(_ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
        ws?.send(.string(s)) { e in if let e = e { log("ws send: \(e.localizedDescription)") } }
    }
    func receive() {
        ws?.receive { [weak self] r in
            guard let self = self else { return }
            switch r {
            case .failure(let e): log("ws closed: \(e.localizedDescription)"); DispatchQueue.main.async { self.finish("completed", "relay closed") }
            case .success(let m):
                if case .string(let s) = m, let d = s.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                    switch o["event"] as? String ?? "" {
                    case "media": if let p = (o["media"] as? [String: Any])?["payload"] as? String, let a = Data(base64Encoded: p) { self.player.play(pcm16: a) }
                    case "clear": self.player.clear()
                    case "hangup": log("relay: hangup (\(o["reason"] as? String ?? ""))"); DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.finish("completed", o["reason"] as? String ?? "hangup") }
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
        if let e = player.start(deviceID: bh) { return "player: \(e)" }
        player.tone(seconds: 0.05, hz: 1) // our process object, so the tap can exclude us
        prevInput = defaultDevice(input: true)
        setDefaultInput(bh)
        log("default input → BlackHole (was \(deviceUID(prevInput)))")
        // relay stream
        var comps = URLComponents(url: relay, resolvingAgainstBaseURL: false)!
        comps.scheme = comps.scheme == "http" ? "ws" : "wss"; comps.path = "/phone/stream"
        ws = URLSession.shared.webSocketTask(with: comps.url!)
        ws?.resume(); receive()
        send(["event": "start", "start": ["streamSid": "ft-\(id)", "customParameters": ["call": id, "key": key, "format": "pcm16", "wait": "1"]]])
        // dial
        NSWorkspace.shared.open(URL(string: "facetime-audio://\(to)")!)
        log("dialling FaceTime Audio \(to.prefix(4))…")
        state = "confirm"
        tick()
        return nil
    }
    var confirmTries = 0
    func tick() {
        if ended { return }
        let t = Date().timeIntervalSince(startedAt)
        switch state {
        case "confirm":
            if press(["call", "facetime audio"]) || callTimerVisible() || findButton(["end", "end call", "leave"]) != nil {
                state = "ringing"; startedAt = Date(); log("ringing")
            } else if t > 12 {
                log("no Call confirmation found; UI:\n\(dumpUI())"); return finish("failed", "could not start the FaceTime call")
            }
        case "ringing":
            if callTimerVisible() {
                state = "live"; answeredAt = Date(); log("answered")
                let me = processObject(pid: getpid())
                cap.onPCM = { [weak self] d in self?.send(["event": "media", "media": ["payload": d.base64EncodedString()]]) }
                if let e = cap.start(excluding: me != 0 ? [me] : []) { log("capture failed: \(e)"); return finish("failed", "no audio capture permission") }
                send(["event": "answered"])
            } else if t > ringSeconds {
                log("no answer after \(Int(ringSeconds)) s"); return finish("no-answer", "rang \(Int(ringSeconds)) s")
            } else if t > 4 && findButton(["end", "end call", "leave", "cancel"]) == nil && !callTimerVisible() {
                log("call UI gone while ringing; UI:\n\(dumpUI())"); return finish("no-answer", "declined or unavailable")
            }
        case "live":
            if !callTimerVisible() && findButton(["end", "end call", "leave"]) == nil {
                log("FaceTime call ended"); return finish("completed", "Daniel hung up")
            }
            if t > 330 { return finish("completed", "time cap (Mac)") }
        default: break
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.tick() }
    }
    func finish(_ reason: String, _ detail: String) {
        if ended { return }
        ended = true
        log("ending: \(reason) (\(detail))")
        _ = press(["end", "end call", "leave", "cancel"])
        send(["event": "stop", "stop": ["reason": reason, "detail": detail]])
        cap.stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            self.player.stop()
            if self.prevInput != 0 { setDefaultInput(self.prevInput); log("default input restored") }
            self.ws?.cancel(with: .normalClosure, reason: nil)
            writeResult(["id": self.id, "reason": reason, "detail": detail, "seconds": self.answeredAt.map { Int(Date().timeIntervalSince($0)) } ?? 0])
            exit(reason == "failed" ? 1 : 0)
        }
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
if flags.contains("--dump") { print(dumpUI()); exit(0) }
guard let id = opts["--call"], let key = opts["--key"], let to = opts["--to"], let r = opts["--relay"], let relay = URL(string: r) else {
    log("usage: MiaCall --call <id> --key <k> --to <+27…> --relay <url> | --check | --selftest | --dump"); exit(2)
}
let call = Call(id: id, key: key, to: to, relay: relay)
if let e = call.start() { log("cannot call: \(e)"); writeResult(["id": id, "reason": "failed", "detail": e]); exit(1) }
// Safety net: never outlive the cap by much.
DispatchQueue.main.asyncAfter(deadline: .now() + 420) { call.finish("completed", "watchdog") }
app.run()
