import Foundation

/// Mia's talk-mode voice, kept warm (task 0447). Talk mode asks for her reply
/// one sentence at a time; running `mia-tts` per sentence cost ~3 s each, most
/// of it Python start-up and loading Kokoro. This keeps one
/// `~/voice-lab/server/mia-tts-worker` process alive with Kokoro af_heart
/// loaded (~0.4 s for a short sentence, faster than it plays back) and feeds
/// it one JSON line per request on stdin, reading one JSON line back.
///
/// Requests run strictly one after another on `queue`, so sentences come back
/// in the order the panel asked for them. The worker exits by itself after
/// 30 idle minutes; the next request (or a `warm`) starts it again (~2.5 s).
/// A hung worker is killed after `timeout`. Any failure → nil, and the caller
/// falls back to the one-shot `mia-tts` CLI.
final class TtsWorker {
    static let shared = TtsWorker()

    let queue = DispatchQueue(label: "mia.tts.worker", qos: .userInitiated)
    private let path: String
    private var proc: Process?
    private var input: FileHandle?
    private var output: FileHandle?
    private var buffer = Data()
    private var seq = 0

    init(path: String? = nil) {
        self.path = path
            ?? ProcessInfo.processInfo.environment["MIA_TTS_WORKER"]
            ?? (NSHomeDirectory() as NSString).appendingPathComponent("voice-lab/server/mia-tts-worker")
        // A worker that died leaves a broken pipe; writing to it must fail, not kill the app.
        signal(SIGPIPE, SIG_IGN)
    }

    var installed: Bool { FileManager.default.isExecutableFile(atPath: path) }

    /// Load the model ahead of the first sentence (talk mode just opened).
    func warm() {
        queue.async { _ = self.ask(["warm": true], timeout: 20) }
    }

    /// Make `text` into audio at `out` (m4a). Call on `queue`.
    /// → (engine, ms) or nil when the worker can't.
    func synth(_ text: String, out: String, timeout: TimeInterval = 20) -> (engine: String, ms: Int)? {
        dispatchPrecondition(condition: .onQueue(queue))
        guard let r = ask(["text": text, "out": out, "format": "m4a"], timeout: timeout),
              r["ok"] as? Bool == true,
              let size = (try? FileManager.default.attributesOfItem(atPath: out))?[.size] as? Int, size > 0
        else { return nil }
        return ((r["engine"] as? String) ?? "kokoro", (r["ms"] as? Int) ?? 0)
    }

    // MARK: - process

    private func ask(_ req: [String: Any], timeout: TimeInterval) -> [String: Any]? {
        guard installed else { return nil }
        for _ in 0..<2 {
            guard ensureRunning() else { return nil }
            seq += 1
            let id = "r\(seq)"
            var body = req
            body["id"] = id
            guard let data = try? JSONSerialization.data(withJSONObject: body),
                  (try? input?.write(contentsOf: data + Data("\n".utf8))) != nil
            else { stop(); continue } // died since last time: start a fresh one, once
            if let line = readLine(timeout: timeout),
               let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
               obj["id"] as? String == id {
                return obj
            }
            stop() // hung, crashed or out of step: never reuse it
            return nil
        }
        return nil
    }

    private func ensureRunning() -> Bool {
        if let p = proc, p.isRunning { return true }
        stop()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        let inPipe = Pipe(), outPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return false }
        proc = p
        input = inPipe.fileHandleForWriting
        output = outPipe.fileHandleForReading
        buffer = Data()
        // First line: {"ready":true,…} once Kokoro is loaded and warmed.
        guard let line = readLine(timeout: 30),
              let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
              obj["ready"] as? Bool == true
        else { stop(); return false }
        return true
    }

    /// One line from the worker's stdout, or nil on EOF / after `timeout`
    /// (then the worker is terminated, which ends the blocked read).
    private func readLine(timeout: TimeInterval) -> Data? {
        guard let out = output, let p = proc else { return nil }
        let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
        defer { killer.cancel() }
        while true {
            if let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<nl]
                buffer = Data(buffer[buffer.index(after: nl)...])
                if line.isEmpty { continue }
                return Data(line)
            }
            let chunk = out.availableData
            if chunk.isEmpty { return nil } // EOF: the worker exited
            buffer.append(chunk)
        }
    }

    private func stop() {
        if let p = proc, p.isRunning { p.terminate() }
        try? input?.close()
        proc = nil
        input = nil
        output = nil
        buffer = Data()
    }
}
