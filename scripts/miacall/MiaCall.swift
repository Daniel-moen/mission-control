// MiaCall.app — Mia rings Daniel over FaceTime Audio from this Mac (task 0621).
//
// `mia call "…"` asks the relay for a call (POST /phone/call → id + stream key),
// then opens this app:  open -n -g MiaCall.app --args --call <id> --key <k> --to <+27…> --relay <https://…>
//   1. default input → BlackHole 2ch AND FaceTime's own Video › Microphone → BlackHole 2ch
//      (FaceTime's mic = Mia's voice), both restored after (0630)
//   2. facetime-audio://<number>, then presses the "Call" confirmation (Accessibility)
//   3. wss://relay/phone/stream: start {format:pcm16, wait:1} → ringing
//   4. answered (FaceTime shows a call timer) → "answered"; the relay starts the
//      OpenAI Realtime voice. Call audio: a Core Audio process tap on FaceTime's call
//      processes (avconferenced…; muted on the speakers, works with the Mac muted) →
//      24 kHz PCM16 → relay; relay audio → an IOProc on BlackHole only (never the speakers).
//   5. ends on: relay {event:hangup} (Mia's goodbye / 5 min cap), FaceTime call gone,
//      no answer within 45 s. Then "stop" {reason}, restore devices, quit.
// Other modes:  --check   ask for / report the permissions (Accessibility, audio capture)
//               --selftest  mock audio loop: tap hears a tone; BlackHole loops our audio
//               --dump      print FaceTime's accessibility tree (debugging the UI)
//               --route-test  TTS into BlackHole while the default input flips; checks it never hits the speakers
//               --mic       select BlackHole in FaceTime's Video › Microphone (no call)
// Log + result: ~/.mission-control/mia/facetime/<id>.log / .json
import AppKit
import ApplicationServices
import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation
import os

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
let tag = opts["--call"] ?? (flags.contains("--check") ? "check" : flags.contains("--selftest") ? "selftest" : flags.contains("--rehearse") ? "rehearse" : flags.contains("--say-test") ? "say-test" : flags.contains("--route-test") ? "route-test" : flags.contains("--mic") ? "mic" : "run")
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
// 0632: FaceTime's voice processor adds its mic device's OUTPUT tap to the echo reference.
// With BlackHole 2ch as both Mia's output and FaceTime's mic, Mia = echo and is cancelled to
// -120 dB (avconferenced uplink averagePower, calls c_02afeb1960 / c_3b6edf36a1). The fix is
// MiaLoop.driver (build-mialoop.sh): Mia plays into "Mia Voice" (output only, MiaLoop_2_UID)
// and FaceTime records "Mia Mic" (input only, MiaLoop_UID); same buffer, no output tap on
// the mic. Without MiaLoop, BlackHole 2ch is used for both (Daniel will NOT hear Mia).
let env = ProcessInfo.processInfo.environment
let miaLoopInstalled = device(uid: "MiaLoop_UID") != nil && device(uid: "MiaLoop_2_UID") != nil
/// The device Mia's voice is written to.
let blackholeUID = env["MIA_CALL_LOOPBACK"] ?? (miaLoopInstalled ? "MiaLoop_2_UID" : "BlackHole2ch_UID")
/// The device FaceTime uses as its microphone (default input + Video › Microphone).
let micUID = env["MIA_CALL_MIC_UID"] ?? (env["MIA_CALL_LOOPBACK"] == nil && miaLoopInstalled ? "MiaLoop_UID" : blackholeUID)
var micName: String { device(uid: micUID).map { objString($0, kAudioObjectPropertyName) } ?? "BlackHole 2ch" }
var voiceName: String { device(uid: blackholeUID).map { objString($0, kAudioObjectPropertyName) } ?? "BlackHole 2ch" }
func isOurMic(_ title: String) -> Bool { let t = title.lowercased(); return t.contains("blackhole") || t.contains(micName.lowercased()) }

// MARK: - capture: process tap (everything but us) → 24 kHz mono Int16
final class Capture {
    var tapID = AudioObjectID(0), aggID = AudioObjectID(0), proc: AudioDeviceIOProcID?
    var onPCM: (Data) -> Void = { _ in }
    var rms: Float = 0
    private var rate: Double = 48000, channels = 2, interleaved = true
    private var phase: Double = 0, acc = [Int16]()
    var tapped = "everything"
    /// processes non-empty: a tap on exactly those (FaceTime's call audio, 0630); else
    /// everything but `excluding`. Taps read process output before the device volume,
    /// so this works with the Mac's output muted; mutedWhenTapped keeps it off the speakers.
    func start(excluding: [AudioObjectID], processes: [AudioObjectID] = []) -> String? {
        let desc = processes.isEmpty ? CATapDescription(stereoGlobalTapButExcludeProcesses: excluding) : CATapDescription(stereoMixdownOfProcesses: processes)
        tapped = processes.isEmpty ? "all processes but MiaCall" : "\(processes.count) call-audio process(es)"
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
        log("capture: tap on \(tapped), \(Int(rate)) Hz × \(channels) \(interleaved ? "interleaved" : "planar"), main device \(outUID)")
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
// 0630: an IOProc bound to BlackHole's device ID. The 0621–0629 AVAudioEngine player
// was re-bound by macOS to the DEFAULT OUTPUT (the speakers) the moment MiaCall set the
// default input to BlackHole (reproduced locally, no config-change notification): Mia
// played on the laptop speaker and FaceTime's mic got nothing. A device IOProc can't move.
final class Player {
    private(set) var devID = AudioDeviceID(0)
    private var proc: AudioDeviceIOProcID?
    private let lock: UnsafeMutablePointer<os_unfair_lock> = { let p = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1); p.initialize(to: os_unfair_lock()); return p }()
    private var q = [Float](), head = 0, phase = 0.0
    private var rate = 48000.0
    private var rateListener: AudioObjectPropertyListenerBlock?
    func start(deviceID: AudioDeviceID) -> String? {
        devID = deviceID
        var a = prop(kAudioDevicePropertyNominalSampleRate); var r = Float64(0); var sz = UInt32(MemoryLayout<Float64>.size)
        if AudioObjectGetPropertyData(deviceID, &a, 0, nil, &sz, &r) == noErr, r > 0 { rate = r }
        let l: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            guard let self = self else { return }
            var a = prop(kAudioDevicePropertyNominalSampleRate); var r = Float64(0); var sz = UInt32(MemoryLayout<Float64>.size)
            if AudioObjectGetPropertyData(self.devID, &a, 0, nil, &sz, &r) == noErr, r > 0 { self.rate = r; log("BlackHole sample rate → \(Int(r)) Hz") }
        }
        rateListener = l
        AudioObjectAddPropertyListenerBlock(deviceID, &a, DispatchQueue.global(), l)
        var st = AudioDeviceCreateIOProcIDWithBlock(&proc, deviceID, DispatchQueue(label: "miacall.play", qos: .userInteractive)) { [weak self] _, _, _, out, _ in
            self?.render(out)
        }
        if st != noErr { return "AudioDeviceCreateIOProcIDWithBlock \(st)" }
        disableInputStreams()
        st = AudioDeviceStart(deviceID, proc)
        if st != noErr { return "AudioDeviceStart \(st)" }
        return nil
    }
    /// Output only: we never read BlackHole's input (no mic indicator, not an input client).
    private func disableInputStreams() {
        guard let p = proc else { return }
        var a = prop(kAudioDevicePropertyIOProcStreamUsage, kAudioObjectPropertyScopeInput); var sz: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(devID, &a, 0, nil, &sz) == noErr, sz >= UInt32(MemoryLayout<UnsafeMutableRawPointer>.size + 4) else { return }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(sz), alignment: 8); defer { raw.deallocate() }
        raw.storeBytes(of: unsafeBitCast(p, to: UnsafeMutableRawPointer.self), as: UnsafeMutableRawPointer.self)
        guard AudioObjectGetPropertyData(devID, &a, 0, nil, &sz, raw) == noErr else { return }
        let n = Int(raw.load(fromByteOffset: MemoryLayout<UnsafeMutableRawPointer>.size, as: UInt32.self))
        for i in 0..<n { raw.storeBytes(of: UInt32(0), toByteOffset: MemoryLayout<UnsafeMutableRawPointer>.size + 4 + 4 * i, as: UInt32.self) }
        AudioObjectSetPropertyData(devID, &a, 0, nil, sz, raw)
    }
    /// Peak of the samples handed to BlackHole since the last read (proves the voice is written).
    private var peakOut: Float = 0
    /// 0633 half-duplex: when Mia's voice last went out (uptime ns), and whether she is speaking
    /// now or was within `tail` seconds (her queue isn't empty, or a sample was written recently).
    private var lastVoiceAt: UInt64 = 0
    func speaking(tail: Double = 0.4) -> Bool {
        os_unfair_lock_lock(lock); defer { os_unfair_lock_unlock(lock) }
        if q.count - head > 0 { return true }
        return lastVoiceAt != 0 && Double(DispatchTime.now().uptimeNanoseconds - lastVoiceAt) / 1e9 < tail
    }
    func takePeak() -> Float { os_unfair_lock_lock(lock); defer { peakOut = 0; os_unfair_lock_unlock(lock) }; return peakOut }
    private func render(_ out: UnsafeMutablePointer<AudioBufferList>) {
        let abl = UnsafeMutableAudioBufferListPointer(out)
        guard let b0 = abl.first, b0.mData != nil else { return }
        let ch0 = max(1, Int(b0.mNumberChannels)), n = Int(b0.mDataByteSize) / 4 / ch0
        var mono = [Float](repeating: 0, count: n)
        let step = 24000 / rate
        os_unfair_lock_lock(lock)
        for i in 0..<n {
            let j = head + Int(phase)
            if j + 1 >= q.count { if j < q.count { mono[i] = q[j] }; head = q.count; phase = 0; break }
            let t = Float(phase - Double(Int(phase)))
            mono[i] = q[j] * (1 - t) + q[j + 1] * t
            phase += step
            if phase >= 1 { head += Int(phase); phase -= Double(Int(phase)) }
        }
        if head > 48000 { q.removeFirst(head); head = 0 }
        for v in mono { peakOut = max(peakOut, abs(v)) }
        if mono.contains(where: { abs($0) > 0.001 }) { lastVoiceAt = DispatchTime.now().uptimeNanoseconds }
        os_unfair_lock_unlock(lock)
        for b in abl {
            guard let d = b.mData else { continue }
            let ch = max(1, Int(b.mNumberChannels)), f = d.assumingMemoryBound(to: Float.self)
            let frames = min(n, Int(b.mDataByteSize) / 4 / ch)
            for i in 0..<frames { for c in 0..<ch { f[i * ch + c] = mono[i] } }
        }
    }
    func play(pcm16 d: Data) {
        let n = d.count / 2
        guard n > 0 else { return }
        var f = [Float](repeating: 0, count: n)
        d.withUnsafeBytes { raw in
            let s = raw.bindMemory(to: Int16.self)
            for i in 0..<n { f[i] = Float(Int16(littleEndian: s[i])) / 32768 }
        }
        os_unfair_lock_lock(lock); q.append(contentsOf: f); os_unfair_lock_unlock(lock)
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
    /// Seconds of audio still queued.
    var queued: Double { os_unfair_lock_lock(lock); defer { os_unfair_lock_unlock(lock) }; return Double(q.count - head) / 24000 }
    func clear() { os_unfair_lock_lock(lock); q.removeAll(); head = 0; phase = 0; os_unfair_lock_unlock(lock) }
    func stop() {
        if let p = proc { AudioDeviceStop(devID, p); AudioDeviceDestroyIOProcID(devID, p) }
        if let l = rateListener { var a = prop(kAudioDevicePropertyNominalSampleRate); AudioObjectRemovePropertyListenerBlock(devID, &a, DispatchQueue.global(), l) }
        proc = nil; rateListener = nil
    }
}

/// Core Audio's view of a process: which devices it is actually playing to / recording from.
struct AudioClient { let obj: AudioObjectID, pid: pid_t, bundle: String, outs: [String], ins: [String], runningOut: Bool, runningIn: Bool }
func objectList(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> [AudioObjectID] {
    var a = prop(sel, scope); var sz: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(obj, &a, 0, nil, &sz) == noErr, sz > 0 else { return [] }
    var v = [AudioObjectID](repeating: 0, count: Int(sz) / MemoryLayout<AudioObjectID>.size)
    AudioObjectGetPropertyData(obj, &a, 0, nil, &sz, &v); return v
}
func objString(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String {
    var a = prop(sel); var s: Unmanaged<CFString>?; var sz = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(obj, &a, 0, nil, &sz, &s) == noErr, let v = s else { return "" }
    return v.takeRetainedValue() as String
}
func objU32(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector) -> UInt32 {
    var a = prop(sel); var v: UInt32 = 0; var sz = UInt32(4); AudioObjectGetPropertyData(obj, &a, 0, nil, &sz, &v); return v
}
func audioClients() -> [AudioClient] {
    objectList(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList).map { po in
        var a = prop(kAudioProcessPropertyPID); var pid: pid_t = 0; var sz = UInt32(4); AudioObjectGetPropertyData(po, &a, 0, nil, &sz, &pid)
        return AudioClient(obj: po, pid: pid, bundle: objString(po, kAudioProcessPropertyBundleID),
                           outs: objectList(po, kAudioProcessPropertyDevices, kAudioObjectPropertyScopeOutput).map { objString($0, kAudioObjectPropertyName) },
                           ins: objectList(po, kAudioProcessPropertyDevices, kAudioObjectPropertyScopeInput).map { objString($0, kAudioObjectPropertyName) },
                           runningOut: objU32(po, kAudioProcessPropertyIsRunningOutput) != 0, runningIn: objU32(po, kAudioProcessPropertyIsRunningInput) != 0)
    }
}
/// Where MiaCall's own audio is going right now (want exactly ["BlackHole 2ch"]).
func myOutputDevices() -> [String] { audioClients().first { $0.pid == getpid() }?.outs ?? [] }
/// The processes that carry FaceTime call audio: avconferenced (FaceTime's audio engine),
/// callservicesd, FaceTime, plus anyone else recording from BlackHole (= using Mia as its mic).
let CALL_AUDIO_BUNDLES: Set<String> = ["com.apple.avconferenced", "com.apple.TelephonyUtilities", "com.apple.FaceTime", "com.apple.InCallService"]
func callAudioClients() -> [AudioClient] {
    let bhName = micName
    return audioClients().filter { c in c.pid != getpid() && (CALL_AUDIO_BUNDLES.contains(c.bundle) || (c.runningIn && c.ins.contains(bhName))) }
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

// MARK: - FaceTime's own microphone choice (Video › Microphone) — task 0630
// FaceTime keeps its own mic selection and can ignore the system default input, so
// MiaCall picks "BlackHole 2ch" in FaceTime's menu before dialling and puts the old
// choice back afterwards. Menu items are read and pressed via AX without opening the
// menu; if the list is built lazily (empty until shown) the menu is opened via AX once.
struct MenuItem { let title: String, checked: Bool, enabled: Bool, el: AXUIElement }
func menuItems(_ menu: AXUIElement) -> [MenuItem] {
    ((axAttr(menu, kAXChildrenAttribute) as? [AXUIElement]) ?? []).map { e in
        MenuItem(title: axStr(e, kAXTitleAttribute), checked: !axStr(e, "AXMenuItemMarkChar").isEmpty,
                 enabled: (axAttr(e, kAXEnabledAttribute) as? Bool) ?? true, el: e)
    }
}
func faceTimeApp(launch: Bool) -> NSRunningApplication? {
    if let a = NSRunningApplication.runningApplications(withBundleIdentifier: FACETIME).first { return a }
    guard launch, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: FACETIME) else { return nil }
    let c = NSWorkspace.OpenConfiguration(); c.activates = false; c.addsToRecentItems = false
    NSWorkspace.shared.openApplication(at: url, configuration: c, completionHandler: nil)
    log("FaceTime was not running: launched it (in the background) to set its microphone")
    for _ in 0..<40 { Thread.sleep(forTimeInterval: 0.2); if let a = NSRunningApplication.runningApplications(withBundleIdentifier: FACETIME).first { return a } }
    return nil
}
/// FaceTime's menu bar menus: [(menu-bar title, menu-bar item, its AXMenu)].
func faceTimeMenus(_ app: NSRunningApplication) -> [(String, AXUIElement, AXUIElement)] {
    let ax = AXUIElementCreateApplication(app.processIdentifier); AXUIElementSetMessagingTimeout(ax, 1.0)
    guard let bar = axAttr(ax, kAXMenuBarAttribute) else { return [] }
    var out: [(String, AXUIElement, AXUIElement)] = []
    for item in (axAttr(bar as! AXUIElement, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
        if let m = (axAttr(item, kAXChildrenAttribute) as? [AXUIElement])?.first { out.append((axStr(item, kAXTitleAttribute), item, m)) }
    }
    return out
}
/// The Microphone section: the items after a "Microphone" header up to the next separator/header;
/// failing that, the run of items around one whose title mentions BlackHole.
func micSection(_ items: [MenuItem]) -> [MenuItem] {
    func isBreak(_ m: MenuItem) -> Bool { m.title.isEmpty || !m.enabled }
    if let h = items.firstIndex(where: { $0.title.trimmingCharacters(in: .whitespaces).lowercased() == "microphone" }) {
        var sec: [MenuItem] = []
        for m in items[(h + 1)...] { if isBreak(m) { break }; sec.append(m) }
        if !sec.isEmpty { return sec }
    }
    guard let b = items.firstIndex(where: { isOurMic($0.title) }) else { return [] }
    var lo = b, hi = b
    while lo > 0 && !isBreak(items[lo - 1]) { lo -= 1 }
    while hi + 1 < items.count && !isBreak(items[hi + 1]) { hi += 1 }
    return Array(items[lo...hi])
}
func describeMenu(_ items: [MenuItem]) -> String {
    items.map { $0.title.isEmpty ? "—" : ($0.checked ? "✓" : "") + $0.title + ($0.enabled ? "" : " (header)") }.joined(separator: " | ")
}
/// Finds the mic list (any menu; FaceTime puts it under Video). Returns (menu title, all items, mic section, bar item, menu).
func findMicMenu(_ app: NSRunningApplication, open: Bool) -> (String, [MenuItem], [MenuItem], AXUIElement, AXUIElement)? {
    let menus = faceTimeMenus(app)
    let order = menus.filter { $0.0 == "Video" } + menus.filter { $0.0 != "Video" && $0.0 != "Apple" }
    for (t, item, m) in order {
        var items = menuItems(m), sec = micSection(items)
        if sec.isEmpty && open && t == "Video" {
            // Lazily built menu: open it, read, (the caller presses an item, which closes it).
            AXUIElementPerformAction(item, kAXPressAction as CFString); Thread.sleep(forTimeInterval: 0.4)
            items = menuItems(m); sec = micSection(items)
            if sec.isEmpty { AXUIElementPerformAction(m, kAXCancelAction as CFString) }
        }
        if !sec.isEmpty { return (t, items, sec, item, m) }
    }
    return nil
}
/// Make FaceTime's microphone `want` (substring, case-insensitive). Returns (ok, previously checked title, log line).
@discardableResult func setFaceTimeMic(_ want: String, launch: Bool = true) -> (ok: Bool, prev: String?, info: String) {
    guard let app = faceTimeApp(launch: launch) else { return (false, nil, "FaceTime is not running") }
    var found: (String, [MenuItem], [MenuItem], AXUIElement, AXUIElement)?
    for i in 0..<25 { // FaceTime's menu bar takes a moment after launch
        found = findMicMenu(app, open: i == 3 || i == 12)
        if found != nil { break }
        Thread.sleep(forTimeInterval: 0.2)
    }
    guard let (menuTitle, all, sec, _, _) = found else {
        let menus = faceTimeMenus(app).map { "\($0.0): " + describeMenu(menuItems($0.2)) }.joined(separator: "\n  ")
        return (false, nil, "no Microphone list in FaceTime's menus:\n  \(menus)")
    }
    let prev = sec.first { $0.checked }?.title
    let w = want.lowercased()
    guard let target = sec.first(where: { $0.title.lowercased() == w }) ?? sec.first(where: { $0.title.lowercased().contains(w) }) else {
        return (false, prev, "\(menuTitle) › Microphone has no \"\(want)\": \(describeMenu(sec))")
    }
    if target.checked { return (true, prev, "FaceTime mic already \"\(target.title)\" (\(menuTitle) menu: \(describeMenu(all)))") }
    let r = AXUIElementPerformAction(target.el, kAXPressAction as CFString)
    Thread.sleep(forTimeInterval: 0.5)
    let now = findMicMenu(app, open: false)?.2.first { $0.checked }?.title
    let ok = now.map { $0.lowercased().contains(w) } ?? (r == .success) // no checkmarks exposed: trust the press
    return (ok, prev, "FaceTime mic \"\(prev ?? "?")\" → pressed \"\(target.title)\" (\(r.rawValue)); now checked: \"\(now ?? "?")\" (\(menuTitle) menu: \(describeMenu(all)))")
}

// MARK: - modes
func checkPermissions(prompt: Bool) -> [String: Any] {
    let ax = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary)
    var res: [String: Any] = ["accessibility": ax, "blackhole": device(uid: blackholeUID) != nil && device(uid: micUID) != nil, "miaLoop": miaLoopInstalled]
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
    // 0630: like a call, tap ONE process (afplay stands in for avconferenced), not everything.
    let tone = Process(); tone.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
    tone.arguments = ["/System/Library/Sounds/Submarine.aiff"]
    try? tone.run()
    var target: AudioObjectID = 0
    for _ in 0..<20 { Thread.sleep(forTimeInterval: 0.05); target = processObject(pid: tone.processIdentifier); if target != 0 { break } }
    if let e = cap.start(excluding: me != 0 ? [me] : [], processes: target != 0 ? [target] : []) { log("selftest: capture failed: \(e)"); return 1 }
    tone.waitUntilExit()
    Thread.sleep(forTimeInterval: 0.3)
    log(String(format: "selftest: tap (%@) → %d frames at 24 kHz, peak %.3f while afplay played", cap.tapped, frames, heard))
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
    var prevInput = AudioDeviceID(0), prevFaceTimeMic: String?, micOK = false
    var state = "starting", answeredAt: Date?, ringingAt: Date?, ended = false
    let launchedAt = Date(), ringSeconds: Double, rehearsal: Bool
    var lastPressAt = Date.distantPast, sawConfirm = false
    var lastSig = "", confirmPresses = 0, broughtForward = false, sentReturn = false
    var sawCallUI = false, sawRingingText = false, noUITicks = 0, quietUITicks = 0, timerSeen: String?
    var mediaIn = 0, mediaBytes = 0, firstMediaAt: Date?, fallbackSpoken = false, lastStats = Date(), speechUntil = Date.distantPast, gatedChunks = 0, bargeIns = 0
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
        guard let bh = device(uid: blackholeUID), let mic = device(uid: micUID) else { return "\(blackholeUID)/\(micUID) is not installed" }
        if !miaLoopInstalled { log("WARNING: MiaLoop.driver not installed: FaceTime's echo canceller will remove Mia from BlackHole 2ch (0632). Install it: scripts/miacall/build-mialoop.sh") }
        if !AXIsProcessTrusted() { return "MiaCall has no Accessibility permission (System Settings › Privacy & Security › Accessibility)" }
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.0)
        prevInput = defaultDevice(input: true)
        if prevInput == mic || prevInput == bh, let mic = ProcessInfo.processInfo.environment["MIA_CALL_RESTORE_INPUT"].flatMap({ device(uid: $0) }) ?? device(uid: "BuiltInMicrophoneDevice") { prevInput = mic }
        setDefaultInput(mic)
        log("Mia's voice → \(voiceName); FaceTime mic = \(micName). default input → \(micName) (was \(deviceUID(prevInput))); now \(deviceUID(defaultDevice(input: true)))")
        if let e = player.start(deviceID: bh) { return "player: \(e)" }
        player.tone(seconds: 0.05, hz: 1) // our process object, so the tap can exclude us
        // FaceTime's own Video › Microphone choice wins over the system default: pick BlackHole there.
        let m = setFaceTimeMic(micName)
        micOK = m.ok
        if let p = m.prev, !isOurMic(p) { prevFaceTimeMic = p }
        log((m.ok ? "" : "WARNING: FaceTime mic NOT set to \(micName); Daniel may not hear Mia. ") + m.info)
        Thread.sleep(forTimeInterval: 0.3)
        log("Mia's audio goes to: \(myOutputDevices())")
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
                let m = setFaceTimeMic(micName, launch: false) // in-call check: FaceTime may reset it per call
                log("in call: " + (m.ok ? "" : "WARNING ") + m.info)
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
                let outs = myOutputDevices()
                // 0632/0633: the capture aggregate is clocked by the default output, so Core Audio lists
                // the speakers under MiaCall while it runs; that is the tap's clock, not Mia's voice.
                let clock = objString(defaultDevice(input: false), kAudioObjectPropertyName)
                log(String(format: "live %d s: timer %@, relay audio %d chunks / %.1f s, call audio rms %.4f, gated %.1f s, barge-ins %d, Mia's voice → %@ (tap clock: %@)", Int(inState), timer ?? "-", mediaIn, Double(mediaBytes) / 48000, cap.rms, Double(gatedChunks) * 0.04, bargeIns, outs.filter { $0 != clock }.description, clock))
                if outs.contains(where: { $0 != voiceName && !$0.lowercased().contains("blackhole") && $0 != clock }) { log("WARNING: Mia's audio is reaching \(outs), not only \(voiceName)") }
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
        // 0633 half-duplex safety net with barge-in: while Mia speaks (+400 ms), Daniel's side goes
        // up as silence, so any echo of her voice from his speakerphone can't come back as his words,
        // UNLESS it is clearly louder than that echo (he is talking over her): then it passes
        // (opens after 2 loud 40 ms chunks, stays open 800 ms) and the relay stops her.
        // MIA_CALL_DUPLEX=full: no gate. MIA_CALL_DUPLEX=half: strict, no barge-in.
        let mode = ProcessInfo.processInfo.environment["MIA_CALL_DUPLEX"] ?? "barge"
        log("echo gate: \(mode == "full" ? "off" : mode == "half" ? "strict half-duplex" : "half-duplex with barge-in (loud speech passes)")")
        var floor: Float = 0.002, loud = 0, openUntil = Date.distantPast
        cap.onPCM = { [weak self] d in
            guard let self = self else { return }
            var pass = true
            if mode != "full" && self.player.speaking(tail: 0.4) {
                var e: Float = 0; let n = d.count / 2
                d.withUnsafeBytes { raw in let p = raw.bindMemory(to: Int16.self); for i in 0..<n { let v = Float(p[i]) / 32768; e += v * v } }
                let r = n > 0 ? sqrt(e / Float(n)) : 0
                if mode == "half" { pass = false }
                else if Date() < openUntil { pass = true; if r > max(0.008, floor * 3) { openUntil = Date().addingTimeInterval(0.8) } }
                else if r > max(0.008, floor * 3) {
                    loud += 1
                    if loud >= 2 { openUntil = Date().addingTimeInterval(0.8); pass = true; self.bargeIns += 1; log(String(format: "barge-in: rms %.4f over echo floor %.4f", r, floor)) } else { pass = false }
                } else { loud = 0; floor = floor * 0.95 + min(r, 0.05) * 0.05; pass = false }
            } else { loud = 0 }
            if pass { self.send(["event": "media", "media": ["payload": d.base64EncodedString()]]) }
            else { self.gatedChunks += 1; self.send(["event": "media", "media": ["payload": Data(count: d.count).base64EncodedString()]]) }
        }
        // Daniel's side = FaceTime's call output (process tap), never a microphone.
        let callers = ProcessInfo.processInfo.environment["MIA_CALL_TAP"] == "global" ? [] : callAudioClients()
        log("call-audio processes: " + (callers.isEmpty ? "none found → tapping everything but MiaCall" : callers.map { "\($0.bundle.isEmpty ? "pid \($0.pid)" : $0.bundle) out=\($0.outs) in=\($0.ins)" }.joined(separator: "; ")))
        if let e = cap.start(excluding: me != 0 ? [me] : [], processes: callers.map { $0.obj }) { log("capture failed: \(e)"); return finish("failed", "no audio capture permission") }
        axq.asyncAfter(deadline: .now() + 3) {
            let playing = audioClients().filter { $0.runningOut && $0.pid != getpid() }.map { "\($0.bundle.isEmpty ? "pid \($0.pid)" : $0.bundle)→\($0.outs)" }
            log("+3 s: processes playing audio: \(playing); Mia → \(myOutputDevices())")
        }
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
                if let p = self.prevFaceTimeMic { log("restore: " + setFaceTimeMic(p, launch: false).info) }
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
    var r = checkPermissions(prompt: true)
    if (r["accessibility"] as? Bool) == true {
        // 0630: can MiaCall switch FaceTime's own mic? Select BlackHole, then put the old one back.
        let m = setFaceTimeMic(micName)
        r["faceTimeMic"] = m.ok; log("check: " + m.info)
        if let p = m.prev, !isOurMic(p) { log("check: restore: " + setFaceTimeMic(p, launch: false).info) }
    }
    log("check: \(r)"); writeResult(r)
    exit(((r["accessibility"] as? Bool) == true && (r["audioCapture"] as? Bool) == true && (r["blackhole"] as? Bool) == true) ? 0 : 1)
}
if flags.contains("--selftest") { exit(selftest()) }
if flags.contains("--mic") {
    // FaceTime's Video › Microphone: show it and select BlackHole (or MIA_CALL_MIC), no call.
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.0)
    let r = setFaceTimeMic(ProcessInfo.processInfo.environment["MIA_CALL_MIC"] ?? micName)
    log("mic: ok=\(r.ok) prev=\(r.prev ?? "-") \(r.info)"); exit(r.ok ? 0 : 1)
}
if flags.contains("--route-test") {
    // The 0630 bug, no call: start the player, then switch the default input to BlackHole
    // (what broke the AVAudioEngine player), play TTS and check where Core Audio sends it.
    guard let bh = device(uid: blackholeUID) else { log("route-test: no BlackHole"); exit(2) }
    let prev = defaultDevice(input: true)
    let p = Player(); if let e = p.start(deviceID: bh) { log("route-test: \(e)"); exit(1) }
    guard let d = sayPCM16("Hi Daniel, it's Mia. This should only go into BlackHole.") else { log("route-test: say failed"); exit(1) }
    p.play(pcm16: d)
    var bad = false
    for i in 0..<8 {
        if i == 2 { setDefaultInput(device(uid: micUID) ?? bh); log("route-test: default input → \(deviceUID(defaultDevice(input: true)))") }
        Thread.sleep(forTimeInterval: 0.4)
        let o = myOutputDevices(); let pk = p.takePeak()
        log("route-test: t+\(String(format: "%.1f", Double(i + 1) * 0.4)) s Mia → \(o), written peak \(String(format: "%.3f", pk)), queued \(String(format: "%.1f", p.queued)) s")
        if i < 6 && pk < 0.01 { bad = true }
        if o.isEmpty || o.contains(where: { $0 != voiceName && !$0.lowercased().contains("blackhole") }) { bad = true }
    }
    setDefaultInput(prev); log("route-test: default input restored → \(deviceUID(defaultDevice(input: true)))")
    p.stop(); log("route-test: \(bad ? "FAIL" : "PASS") (Mia's audio only in BlackHole)"); exit(bad ? 1 : 0)
}
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
    log("usage: MiaCall --call <id> --key <k> --to <+27…> --relay <url> | --check | --selftest | --dump [--all] | --say-test | --route-test | --mic | --rehearse [--to N]"); exit(2)
}
let call = Call(id: id, key: key, to: to, relay: relay, rehearsal: false)
axq.async { if let e = call.start() { log("cannot call: \(e)"); writeResult(["id": id, "reason": "failed", "detail": e]); exit(1) } }
// Safety net: never outlive the cap by much.
DispatchQueue.main.asyncAfter(deadline: .now() + 420) { axq.async { call.finish("completed", "watchdog") } }
app.run()
