import Foundation
import Testing
@testable import AgentWidget

// TtsWorker (task 0447): the warm voice process RemoteBridge feeds talk-mode
// sentences to. A fake worker speaks the same JSON-lines protocol as
// ~/voice-lab/server/mia-tts-worker: "CRASH" makes it exit, "HANG" makes it
// stop answering.

private let fakeWorker = #"""
#!/usr/bin/env python3
import json, os, sys, time
print(json.dumps({"ready": True, "load_ms": 1, "pid": os.getpid()}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    if req.get("warm"):
        print(json.dumps({"id": req["id"], "ok": True, "warm": True}), flush=True); continue
    text = req.get("text", "")
    if text == "CRASH": sys.exit(1)
    if text == "HANG": time.sleep(60)
    with open(req["out"], "w") as f: f.write(f"audio:{text}:{os.getpid()}")
    print(json.dumps({"id": req["id"], "ok": True, "engine": "kokoro", "ms": 5}), flush=True)
"""#

private func makeWorker() throws -> (TtsWorker, URL) {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ttsw-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let script = dir.appendingPathComponent("worker")
    try fakeWorker.write(to: script, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
    return (TtsWorker(path: script.path), dir)
}

private func say(_ w: TtsWorker, _ text: String, in dir: URL, timeout: TimeInterval = 10) -> String? {
    let out = dir.appendingPathComponent("\(UUID().uuidString).m4a").path
    let made = w.queue.sync { w.synth(text, out: out, timeout: timeout) }
    guard made != nil else { return nil }
    return try? String(contentsOfFile: out, encoding: .utf8)
}

@Test func workerAnswersInOrderFromOneProcess() throws {
    let (w, dir) = try makeWorker()
    let a = say(w, "One.", in: dir), b = say(w, "Two.", in: dir), c = say(w, "Three.", in: dir)
    #expect(a?.hasPrefix("audio:One.:") == true)
    #expect(b?.hasPrefix("audio:Two.:") == true)
    #expect(c?.hasPrefix("audio:Three.:") == true)
    // Kept warm: the same process made all three.
    let pids = [a, b, c].compactMap { $0?.split(separator: ":").last }
    #expect(Set(pids).count == 1)
}

@Test func workerCrashFallsBackThenRestarts() throws {
    let (w, dir) = try makeWorker()
    let first = say(w, "Before.", in: dir)
    #expect(say(w, "CRASH", in: dir) == nil) // caller falls back to the mia-tts CLI
    let after = say(w, "After.", in: dir)
    #expect(after?.hasPrefix("audio:After.:") == true)
    #expect(first?.split(separator: ":").last != after?.split(separator: ":").last) // a fresh process
}

@Test func workerHangTimesOut() throws {
    let (w, dir) = try makeWorker()
    let t = Date()
    #expect(say(w, "HANG", in: dir, timeout: 1) == nil)
    #expect(Date().timeIntervalSince(t) < 5)
    #expect(say(w, "Next.", in: dir)?.hasPrefix("audio:Next.:") == true)
}

@Test func warmThenSpeak() throws {
    let (w, dir) = try makeWorker()
    w.warm()
    #expect(say(w, "Warm.", in: dir)?.hasPrefix("audio:Warm.:") == true)
}

@Test func missingWorkerIsNil() {
    let w = TtsWorker(path: "/nonexistent/mia-tts-worker")
    #expect(!w.installed)
    #expect(w.queue.sync { w.synth("Hi.", out: "/tmp/never.m4a") } == nil)
}
