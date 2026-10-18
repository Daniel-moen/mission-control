import Foundation

/// The app's side of mia-core, Mia's job engine (Mia v2 phase 1, task 0292;
/// `scripts/mia-core`, docs/mia-v2.md).
///
/// mia-core is a portable Python service: a SQLite job queue, headless
/// `claude -p` executors, a concurrency cap, model routing + an Opus budget and
/// heartbeat runs. Everything it decides lives on disk; the app only
///   - keeps it running while one of its features is on (`supervise`),
///   - feeds Mia what it writes to `inbox.jsonl` (`newEvents`) — each line once,
///   - shows its `jobs.json` snapshot in the panel's `mia` block,
///   - reads the switches in `core.json` that change app behaviour (`Config`).
/// With `core.json` missing or all switches off, nothing here does anything.
final class MiaCoreLink {
    struct Config: Equatable {
        var headless = false
        var heartbeatRuns = false
        var beats: Set<String> = []
        var miaResume = false
        var legacyCap = false
        var reapLegacy = false
        var maxConcurrent = 4

        /// The core has work to do: start it and keep it up.
        var wantsCore: Bool { headless || heartbeatRuns }

        /// Same defaults as `DEFAULTS` in scripts/mia-core.
        static let defaultBeats: Set<String> = ["hb_health", "hb_scout", "hb_inbox"]

        static func parse(_ data: Data?) -> Config {
            var c = Config()
            guard let data, let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                return c
            }
            c.headless = (o["headless"] as? Bool) ?? false
            c.miaResume = (o["miaResume"] as? Bool) ?? false
            c.legacyCap = (o["legacyCap"] as? Bool) ?? false
            c.reapLegacy = (o["reapLegacy"] as? Bool) ?? false
            if let n = (o["maxConcurrent"] as? NSNumber)?.intValue, n > 0 { c.maxConcurrent = n }
            let hb = o["heartbeats"] as? [String: Any] ?? [:]
            c.heartbeatRuns = (hb["enabled"] as? Bool) ?? false
            if let beats = hb["beats"] as? [String: Any] { c.beats = Set(beats.keys) } else { c.beats = defaultBeats }
            return c
        }
    }

    let dir: String
    private let configPath: String
    private let inboxPath: String
    private let offsetPath: String
    private let snapshotPath: String
    private let pidPath: String
    private let fm = FileManager.default

    private var configStamp: Date?
    private(set) var config = Config()
    private var proc: Process?
    private var nextStartAt = Date.distantPast
    private var seen = Set<String>()
    private var inboxOffset: UInt64?

    init(dir: String) {
        self.dir = dir
        configPath = dir + "/core.json"
        inboxPath = dir + "/inbox.jsonl"
        offsetPath = dir + "/inbox.offset"
        snapshotPath = dir + "/jobs.json"
        pidPath = dir + "/core.pid"
        reloadConfig()
    }

    /// Re-read core.json when it changed (cheap: one stat per call).
    @discardableResult
    func reloadConfig() -> Config {
        let m = (try? fm.attributesOfItem(atPath: configPath))?[.modificationDate] as? Date
        if m != configStamp {
            configStamp = m
            config = Config.parse(fm.contents(atPath: configPath))
        }
        return config
    }

    // MARK: Keeping the service up

    /// The pid in core.pid when that process is alive (ours or one an older
    /// app instance started — it outlives the app on purpose).
    var runningPid: Int32? {
        guard let s = try? String(contentsOfFile: pidPath, encoding: .utf8),
              let pid = Int32(s.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0,
              kill(pid, 0) == 0 || errno == EPERM else { return nil }
        return pid
    }

    func supervise(now: Date) {
        guard reloadConfig().wantsCore else { return }
        if let p = proc, p.isRunning { return }
        proc = nil
        guard now >= nextStartAt else { return }
        // Check about every 30 s; a start that finds another instance exits 3.
        nextStartAt = now.addingTimeInterval(30)
        if runningPid != nil { return }
        let script = NSHomeDirectory() + "/.mission-control/bin/mia-core"
        guard fm.fileExists(atPath: script) else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["python3", script, "run"]
        p.currentDirectoryURL = URL(fileURLWithPath: dir)
        var env = ProcessInfo.processInfo.environment
        // A Finder-launched app has a bare PATH; the core needs python3 and claude.
        let home = NSHomeDirectory()
        env["PATH"] = ["\(home)/.mission-control/bin", "\(home)/.local/bin", "/opt/homebrew/bin",
                       "/usr/local/bin", env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"].joined(separator: ":")
        env["MIA_DIR"] = dir
        for k in env.keys where k.hasPrefix("CLAUDE_CODE") || k == "CLAUDECODE" { env[k] = nil }
        p.environment = env
        p.standardInput = FileHandle.nullDevice
        let logPath = dir + "/core.log"
        if !fm.fileExists(atPath: logPath) { fm.createFile(atPath: logPath, contents: nil) }
        if let h = FileHandle(forWritingAtPath: logPath) {
            h.seekToEndOfFile()
            p.standardOutput = h
            p.standardError = h
        }
        if (try? p.run()) != nil {
            proc = p
            NSLog("Mia: started mia-core (pid \(p.processIdentifier))")
        }
    }

    // MARK: Events for Mia

    struct Event: Equatable {
        let id: String
        let kind: String
        let text: String
        let taskId: String?
        let mirror: String?
        let deliver: Bool
    }

    /// Parse inbox lines; drops malformed ones and ids already seen.
    static func parseInbox(_ text: String, seen: inout Set<String>) -> [Event] {
        var out: [Event] = []
        for line in text.split(separator: "\n") {
            guard let o = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
                  let id = o["id"] as? String, let t = o["text"] as? String,
                  seen.insert(id).inserted else { continue }
            out.append(Event(id: id, kind: o["kind"] as? String ?? "system", text: t,
                             taskId: o["taskId"] as? String, mirror: o["mirror"] as? String,
                             deliver: (o["deliver"] as? Bool) ?? true))
        }
        return out
    }

    /// What mia-core wrote since last time. The read position is kept on disk
    /// (inbox.offset) so events written while the app was down still arrive,
    /// once. `commit` runs after the caller recorded them (events.jsonl).
    func newEvents(commit: ([Event]) -> Void) {
        guard let attrs = try? fm.attributesOfItem(atPath: inboxPath),
              let size = (attrs[.size] as? NSNumber)?.uint64Value else { return }
        var off = inboxOffset ?? UInt64((try? String(contentsOfFile: offsetPath, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "0") ?? 0
        if off > size { off = 0 }          // truncated / replaced
        guard size > off, let fh = FileHandle(forReadingAtPath: inboxPath) else { inboxOffset = off; return }
        defer { try? fh.close() }
        try? fh.seek(toOffset: off)
        let data = fh.readDataToEndOfFile()
        // Only whole lines; a half-written one waits for the next tick.
        guard let lastNL = data.lastIndex(of: UInt8(ascii: "\n")) else { inboxOffset = off; return }
        let chunk = data[data.startIndex...lastNL]
        let events = Self.parseInbox(String(decoding: chunk, as: UTF8.self), seen: &seen)
        commit(events)
        let newOff = off + UInt64(chunk.count)
        inboxOffset = newOff
        try? "\(newOff)\n".write(toFile: offsetPath, atomically: true, encoding: .utf8)
    }

    // MARK: Snapshot

    /// jobs.json for the panel's `mia` block (running, queue, budget, log
    /// tails), or nil when the core never ran.
    func jobsSnapshot() -> [String: Any]? {
        guard let d = fm.contents(atPath: snapshotPath),
              var o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return nil }
        o["online"] = runningPid != nil
        return o
    }

    // MARK: Mia's own session (resume after a restart)

    /// Where Claude Code keeps a session's transcript: the cwd with every
    /// non-alphanumeric character turned into "-".
    static func transcriptPath(home: String, cwd: String, sessionId: String) -> String {
        let enc = String(cwd.map { $0.isLetter || $0.isNumber ? $0 : "-" })
        return "\(home)/.claude/projects/\(enc)/\(sessionId).jsonl"
    }

    /// The first message of a resumed Mia session. Starts like her real
    /// prompt so the app recognises the session whichever line it reads first.
    static func resumeNote(restarts: Int, downSince: Date?) -> String {
        let since = downSince.map { d -> String in
            let f = DateFormatter()
            f.dateFormat = "HH:mm"
            return " (down since \(f.string(from: d)))"
        } ?? ""
        return "\(MiaManager.miaPromptPrefix) — [MC] You were restarted\(since) and this session was resumed, "
            + "so your context is intact (restart \(restarts)). Catch up on what happened while you were "
            + "down: `mia inbox -n 20` and `mia status`, then carry on."
    }
}
