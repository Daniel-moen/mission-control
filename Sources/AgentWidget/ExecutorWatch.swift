import Foundation

/// When is a Mia executor really finished? (task 0244)
///
/// A turn ending is not enough. An executor that starts a crawl or an upload
/// with `run_in_background`, or spawns a background subagent, ends its turn
/// right away ("Command running in background with ID: …") and picks up again
/// when Claude Code types a `<task-notification>` into it. Reporting that
/// turn-end as "finished" is what sent Mia false events right after dispatch,
/// after a tell, and six times over for one task. Nor is a turn that ended on
/// "API Error: Your computer went to sleep mid-response": that is a stall, and
/// the cure is a "resume", not a review.
///
/// The parsing helpers feed AgentRun from transcript lines (AgentManager);
/// `verdict` decides; MiaManager acts on it.
enum ExecutorWatch {

    // MARK: Transcript signals

    /// The id of a background job a tool result just started: a Bash
    /// `run_in_background` command or an async (background) subagent.
    static func backgroundLaunch(_ obj: [String: Any]) -> (id: String, isAgent: Bool)? {
        guard let r = obj["toolUseResult"] as? [String: Any] else { return nil }
        if let id = r["backgroundTaskId"] as? String, !id.isEmpty { return (id, false) }
        if (r["status"] as? String) == "async_launched" || (r["isAsync"] as? Bool) == true,
           let id = r["agentId"] as? String, !id.isEmpty { return (id, true) }
        return nil
    }

    /// Background job ids a `<task-notification>` reports as stopped. Claude
    /// Code writes one when a background command exits or a background agent
    /// stops, first as a queue-operation, then as the user line that wakes
    /// the session.
    static func notifiedTaskIds(_ text: String) -> [String] {
        guard text.contains("<task-notification>") else { return [] }
        var ids: [String] = []
        var rest = text[...]
        while let open = rest.range(of: "<task-id>"),
              let close = rest.range(of: "</task-id>", range: open.upperBound..<rest.endIndex) {
            let id = rest[open.upperBound..<close.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
            if !id.isEmpty { ids.append(id) }
            rest = rest[close.upperBound...]
        }
        return ids
    }

    /// What a user line says: its plain-string content or its text blocks.
    /// Tool results are left out — a command that prints a transcript must
    /// not count as a notification.
    static func userTexts(_ message: [String: Any]?) -> [String] {
        guard let message else { return [] }
        if let s = message["content"] as? String { return [s] }
        let blocks = message["content"] as? [[String: Any]] ?? []
        return blocks.compactMap { ($0["type"] as? String) == "text" ? $0["text"] as? String : nil }
    }

    /// Ids a TaskStop / KillShell call names — the agent stopping its own job.
    static func stoppedTaskIds(_ toolUse: [String: Any]) -> [String] {
        guard let name = toolUse["name"] as? String,
              ["KillShell", "KillBash", "TaskStop"].contains(name),
              let input = toolUse["input"] as? [String: Any] else { return [] }
        return ["shell_id", "bash_id", "task_id", "id"].compactMap { input[$0] as? String }
    }

    /// The synthetic assistant line Claude Code writes when the Mac slept
    /// while a response was streaming.
    static func isSleepError(_ obj: [String: Any]) -> Bool {
        guard (obj["isApiErrorMessage"] as? Bool) == true else { return false }
        let message = obj["message"] as? [String: Any]
        let blocks = message?["content"] as? [[String: Any]] ?? []
        return blocks.contains { ($0["text"] as? String)?.contains("went to sleep") == true }
    }

    // MARK: The decision

    struct Inputs {
        /// The claude process is gone (AgentManager's process scan).
        var exited = false
        var turnEnded = false
        /// The turn-end marker followed (AgentRun.turnClosed).
        var turnClosed = false
        /// uuid of the assistant line that ended the turn — one finish each.
        var turnKey: String?
        /// The turn ended on the sleep API error (its uuid).
        var sleepErrorKey: String?
        /// Background shells still listed as running, and whether the
        /// process tree confirms one (nil when unknown — trust the list).
        var pendingShells = 0
        var shellChildAlive: Bool?
        var pendingAgents = 0
        /// A synchronous-subagent transcript still being written.
        var subagentsWorking = false
        /// The executor noted DONE/BLOCKED since dispatch or the last tell.
        var doneNoted = false
        /// How long the transcript has been quiet, and quiet while the Mac
        /// was awake (since the later of the last write and the last wake).
        var quiet: TimeInterval = 0
        var quietAwake: TimeInterval = 0
        var sessionId = "?"
    }

    enum Verdict: Equatable {
        case working
        case finished(key: String, note: String?)
        case exited(key: String)
        case sleepStall(key: String)
    }

    /// Background work this long without a word, with the turn over, is
    /// presumed abandoned (a job from a process that was restarted, say).
    static let staleBackground: TimeInterval = 8 * 3600

    /// A sleep error is often followed within seconds by a queued
    /// task-notification that restarts the turn on its own; wait this long
    /// before calling it a stall.
    static let sleepGrace: TimeInterval = 20

    /// An `end_turn` with no turn-end marker after it is trusted only after
    /// this long awake and quiet (a transcript that never writes markers).
    static let unclosedGrace: TimeInterval = 180

    static func verdict(_ i: Inputs) -> Verdict {
        let key = "turn:\(i.turnKey ?? i.sessionId)"
        if i.exited {
            // Quitting after a finished turn is that same finish (same key, so
            // it isn't reported twice); background work died with the process.
            if i.turnEnded && i.sleepErrorKey == nil { return .finished(key: key, note: nil) }
            return .exited(key: "exit:\(i.sessionId)")
        }
        guard i.turnEnded, i.turnClosed || i.quietAwake >= unclosedGrace else { return .working }
        if let k = i.sleepErrorKey {
            return i.quiet >= sleepGrace ? .sleepStall(key: "sleep:\(k)") : .working
        }
        // Said DONE (or BLOCKED) and handed control back: finished, even with
        // a dev server still running in the background.
        if i.doneNoted { return .finished(key: key, note: nil) }
        let shells = i.pendingShells > 0 && i.shellChildAlive != false
        let busy = shells || i.pendingAgents > 0 || i.subagentsWorking
        if !busy { return .finished(key: key, note: nil) }
        if i.quiet > staleBackground {
            var what: [String] = []
            if shells { what.append("\(i.pendingShells) background command(s)") }
            if i.pendingAgents > 0 { what.append("\(i.pendingAgents) background agent(s)") }
            if i.subagentsWorking { what.append("a subagent") }
            return .finished(key: key, note: "idle \(Int(i.quiet / 3600))h with \(what.joined(separator: " and ")) still listed as running")
        }
        return .working
    }

    // MARK: The report

    static func mtime(_ path: String) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date
    }

    /// "report updated since your last tell" — compares the report's mtime now
    /// with the one recorded at dispatch / at the last delivered tell.
    static func reportChange(now: Date?, baseline: Date?, sinceTell: Bool) -> String {
        let since = sinceTell ? "your last tell" : "dispatch"
        guard let now else { return "no report file yet" }
        if let baseline, now <= baseline { return "report NOT changed since \(since)" }
        return "report updated since \(since)"
    }

    /// A DONE / BLOCKED note in the task log at or after `since`.
    static func doneNoted(log: [[String: Any]], since: Date) -> Bool {
        log.contains { e in
            guard let text = e["text"] as? String,
                  text.hasPrefix("DONE") || text.hasPrefix("BLOCKED"),
                  let at = MiaManager.date(e["at"]) else { return false }
            return at >= since.addingTimeInterval(-1)
        }
    }
}

/// Keeps the Mac awake while executors work: one `caffeinate -i -s -w <pid>`
/// per working executor (-i idle sleep, -s system sleep on AC; -w ends it with
/// the claude process even if this app quits first). Released when the
/// executor finishes — an interactive session idles at its prompt for hours.
final class KeepAwake {
    private var held: [String: Process] = [:]   // sessionId → caffeinate
    private var heldPid: [String: Int32] = [:]
    var launcher: (_ args: [String]) -> Process? = { args in
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/caffeinate")
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        return p
    }

    var sessions: Set<String> { Set(held.keys) }

    static func args(pid: Int32) -> [String] {
        // No pid yet (process not bound): a short hold, renewed while needed.
        pid > 0 ? ["-i", "-s", "-w", String(pid)] : ["-i", "-s", "-t", "300"]
    }

    /// Hold exactly `want` (sessionId → pid); drop the rest.
    func sync(_ want: [String: Int32]) {
        for (sid, p) in held where want[sid] == nil || !p.isRunning || heldPid[sid] != want[sid] {
            if p.isRunning { p.terminate() }
            held[sid] = nil
            heldPid[sid] = nil
        }
        for (sid, pid) in want where held[sid] == nil {
            if let p = launcher(Self.args(pid: pid)) {
                held[sid] = p
                heldPid[sid] = pid
            }
        }
    }

    func releaseAll() { sync([:]) }
}
