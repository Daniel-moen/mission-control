import Foundation
import Combine
import AppKit

/// Discovers Claude Code sessions that are running/recent on this machine and
/// tracks their progress by tailing their transcript JSONL files. Read-only:
/// it never starts agents itself.
/// Glanceable, aggregate state of the whole fleet — drives the menu-bar icon
/// and the dashboard strip. Recomputed once per tick so the UI and the status
/// item never have to walk every agent themselves.
struct FleetSummary: Equatable {
    var active = 0
    var idle = 0
    var done = 0
    var total = 0
    var attention = 0      // agents that just went quiet — probably waiting on you
    var totalCost = 0.0
    var totalTurns = 0
    var totalTokens = 0          // every token across the fleet (incl. cache)
    var outputTokens = 0         // generated tokens only — the "real work"
    var tokensPerSec = 0.0       // live, fleet-wide burn rate
}

final class AgentManager: ObservableObject {
    @Published var agents: [AgentRun] = []
    /// Aggregate fleet state, refreshed every tick.
    @Published var summary = FleetSummary()
    /// Set the instant an agent finishes — the UI watches this to fire confetti.
    @Published var lastFinishAt: Date?

    private let home = NSHomeDirectory()
    private lazy var projectsDir = "\(home)/.claude/projects"
    private var byId: [String: AgentRun] = [:]
    private var suppressed: Set<String> = []   // sessions the user removed
    private var timer: Timer?

    /// Last status we notified about, per session — so a single transition
    /// fires exactly one notification instead of one per tick.
    private var lastNotifiedStatus: [String: AgentStatus] = [:]
    private var knownSessions: Set<String> = []
    private let settings = Settings.shared

    /// Sessions whose transcript changed within this window are shown.
    private let discoveryWindow: TimeInterval = 20 * 60
    /// Updated more recently than this ⇒ "Working". Generous because extended
    /// thinking and long tool calls write nothing to the transcript meanwhile.
    private let activeWindow: TimeInterval = 60

    var activeCount: Int { agents.filter { $0.status == .active }.count }

    init() { start() }

    func start() {
        tick()
        // Poll quickly so the activity feed reads as live.
        let t = Timer.scheduledTimer(withTimeInterval: 0.7, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    // MARK: Liveness & terminal resolution

    private let term = TerminalBridge()
    /// Resolved cwd → terminal info for every running `claude` process,
    /// refreshed off the main thread (a process scan is too heavy per tick).
    private var liveTerminals: [String: TerminalInfo] = [:]
    private var liveDirs: Set<String> = []
    private var liveScanReady = false
    private var lastLivenessScan = Date.distantPast
    /// How long after the process disappears before we drop the session.
    private let livenessScanInterval: TimeInterval = 2.5

    private func refreshLivenessIfNeeded() {
        guard Date().timeIntervalSince(lastLivenessScan) > livenessScanInterval else { return }
        lastLivenessScan = Date()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let map = self?.term.scan() ?? [:]
            DispatchQueue.main.async {
                self?.liveTerminals = map
                self?.liveDirs = Set(map.keys)
                self?.liveScanReady = true
                self?.assignTerminals()
                // Reap once per scan so the miss count tracks real scans,
                // not the much faster UI tick.
                self?.reapDepartedSessions()
            }
        }
    }

    /// Attach each agent to the terminal its process is running in.
    private func assignTerminals() {
        for run in agents where !run.workingDir.isEmpty {
            let info = liveTerminals[resolved(run.workingDir)]
            if info != run.terminal { run.terminal = info }
        }
    }

    private func resolved(_ path: String) -> String {
        (path as NSString).resolvingSymlinksInPath
    }

    /// Remove agents whose claude process has gone away (the user left/quit it).
    /// Conservative on purpose: a session is only dropped after several
    /// consecutive scans confirm no live process for its folder, and a session
    /// that's still writing its transcript is never touched. Once dropped it's
    /// suppressed so discovery doesn't flicker it back in.
    private func reapDepartedSessions() {
        guard liveScanReady else { return }
        var gone: [AgentRun] = []
        for run in agents where !run.workingDir.isEmpty {
            // A live `claude` process resolves to this folder's cwd whether or
            // not it's actively writing (e.g. mid-way through a long tool call),
            // so the process scan — not transcript recency — is the source of
            // truth for liveness.
            if liveDirs.contains(resolved(run.workingDir)) {
                run.livenessMisses = 0
                run.processAlive = true
            } else {
                run.livenessMisses += 1
                // Two misses (~5s) to ride out a transient lsof race before we
                // call it dead; several more before removing it from the list.
                if run.livenessMisses >= 2 { run.processAlive = false }
                if run.livenessMisses >= 5 { gone.append(run) }
            }
        }
        guard !gone.isEmpty else { return }
        for run in gone {
            suppressed.insert(run.sessionId)   // it's been left — keep it gone
            byId.removeValue(forKey: run.sessionId)
        }
        let goneIds = Set(gone.map { $0.sessionId })
        agents.removeAll { goneIds.contains($0.sessionId) }
    }

    // MARK: Destroy / remove

    /// Kill the running agent process for this session (matched by working
    /// directory), then drop it from the monitor.
    func destroy(_ run: AgentRun) {
        let dir = run.workingDir
        if !dir.isEmpty {
            // Find `claude` processes whose cwd matches and terminate them.
            let script = #"""
            for p in $(ps -axww -o pid=,command= | awk '$2 ~ /(^|\/)claude$/ {print $1}'); do
              c=$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
              [ "$c" = "$AGENT_DIR" ] && kill "$p" 2>/dev/null
            done
            """#
            term.runShell(script, env: ["AGENT_DIR": dir])
        }
        remove(run)
    }

    /// Just stop showing it — does not touch the process.
    func remove(_ run: AgentRun) {
        suppressed.insert(run.sessionId)
        byId.removeValue(forKey: run.sessionId)
        agents.removeAll { $0.sessionId == run.sessionId }
    }

    // MARK: Launch

    /// A single agent to spin up: which model alias to run, and the prompt it
    /// should open on. An empty `model` means "use the CLI default".
    struct LaunchSpec {
        var model: String
        var prompt: String
    }

    /// Spin up one fresh `claude` session per spec, each in its own new Terminal
    /// window rooted at `dir`. We stagger them slightly so Terminal doesn't trip
    /// over a burst of simultaneous `do script` activations. They appear in the
    /// fleet automatically as soon as they write their first transcript line.
    func launchSessions(_ specs: [LaunchSpec], in dir: String) {
        let folder = dir.isEmpty ? home : (dir as NSString).expandingTildeInPath
        for (i, spec) in specs.enumerated() {
            let cmd = launchCommand(dir: folder, model: spec.model, prompt: spec.prompt)
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 0.5) { [weak self] in
                self?.term.launchInTerminal(command: cmd)
            }
        }
    }

    private func launchCommand(dir: String, model: String, prompt: String) -> String {
        let q = TerminalBridge.shellQuote
        var c = "cd \(q(dir))"
        c += " && claude"
        if !model.isEmpty { c += " --model \(model)" }
        c += " \(q(prompt))"
        return c
    }

    // MARK: Manager-led fleet

    /// A coordinated launch: one mission, an optional manager, and a roster of
    /// workers (each a model alias, "" = CLI default). When a manager is present
    /// the agents are wired together through a `.mission-control/` folder so the
    /// workers genuinely take their orders from the manager rather than each
    /// going it alone.
    struct FleetPlan {
        var mission: String
        var dir: String
        var managerModel: String?     // nil ⇒ no manager (workers run solo)
        var workerModels: [String]
        var agentCount: Int { (managerModel == nil ? 0 : 1) + workerModels.count }
    }

    /// Folder, relative to the working dir, that the manager and workers use as
    /// their shared mailbox. Kept relative so the prompts read cleanly.
    private let coordDirName = ".mission-control"

    func launchFleet(_ plan: FleetPlan) {
        let dir = plan.dir.isEmpty ? home : (plan.dir as NSString).expandingTildeInPath
        let coordinated = plan.managerModel != nil
        if coordinated { setupCoordination(dir: dir, mission: plan.mission) }

        var specs: [LaunchSpec] = []
        let n = plan.workerModels.count
        // Manager goes first so its assignments are landing while workers boot
        // and poll for them.
        if let mm = plan.managerModel {
            specs.append(.init(model: mm, prompt: managerPrompt(plan.mission, workerModels: plan.workerModels)))
        }
        for (i, wm) in plan.workerModels.enumerated() {
            let prompt = coordinated
                ? coordinatedWorkerPrompt(plan.mission, number: i + 1, total: n)
                : soloWorkerPrompt(plan.mission, number: i + 1, total: n)
            specs.append(.init(model: wm, prompt: prompt))
        }
        launchSessions(specs, in: dir)
    }

    /// Create the shared mailbox and seed it with the mission, clearing any
    /// stale assignments/outboxes/result from a previous run in this folder so
    /// workers don't pick up orders that aren't theirs.
    private func setupCoordination(dir: String, mission: String) {
        let fm = FileManager.default
        let coord = "\(dir)/\(coordDirName)"
        try? fm.createDirectory(atPath: coord, withIntermediateDirectories: true)
        if let items = try? fm.contentsOfDirectory(atPath: coord) {
            for f in items where f.hasPrefix("worker-") || f == "RESULT.md" {
                try? fm.removeItem(atPath: "\(coord)/\(f)")
            }
        }
        try? mission.write(toFile: "\(coord)/mission.md", atomically: true, encoding: .utf8)
    }

    private func modelLabel(_ flag: String) -> String {
        switch flag {
        case "opus":   return "Opus"
        case "sonnet": return "Sonnet"
        case "haiku":  return "Haiku"
        default:       return "Default"
        }
    }

    private func managerPrompt(_ mission: String, workerModels: [String]) -> String {
        let roster = workerModels.isEmpty
            ? "(no workers — handle the mission yourself)"
            : workerModels.enumerated()
                .map { "  - Worker \($0.offset + 1) — \(modelLabel($0.element))" }
                .joined(separator: "\n")
        return """
        You are the MANAGER agent leading a fleet of \(workerModels.count) worker agent(s) on a shared mission. Your instructions are AUTHORITATIVE — the workers defer to you.

        The mission is recorded in \(coordDirName)/mission.md:

        \(mission)

        Your crew (each running in its own session, already booted and blocked, polling for your orders):
        \(roster)

        COORDINATION PROTOCOL — the workers follow this exact protocol, so use it:
        1. Decompose the mission into clear, self-contained assignments — one per worker.
        2. Write each worker's assignment to \(coordDirName)/worker-<k>.md (e.g. \(coordDirName)/worker-1.md). Be specific: scope, files to touch, constraints, and a clear definition of done. Each worker is BLOCKED until this file appears and will do exactly what it says.
        3. Workers post progress and results to \(coordDirName)/worker-<k>.outbox.md — read these to track them.
        4. To send follow-ups or corrections, append a section headed "## UPDATE <short note>" to that worker's worker-<k>.md; workers re-read it after each chunk of work and obey the latest instructions.
        5. Track the whole effort with TodoWrite. When every worker is done, review and reconcile their outboxes, resolve conflicts, and synthesize one coherent, verified result — write the final summary to \(coordDirName)/RESULT.md.

        Begin NOW by writing each worker's assignment file. Do not wait — they're idling until you do.
        """
    }

    private func coordinatedWorkerPrompt(_ mission: String, number: Int, total: Int) -> String {
        let file = "\(coordDirName)/worker-\(number).md"
        let outbox = "\(coordDirName)/worker-\(number).outbox.md"
        return """
        You are WORKER \(number) of \(total) in a manager-led fleet. You report to the MANAGER agent and FOLLOW ITS INSTRUCTIONS — they override your own assumptions and plans. Do not free-lance.

        Shared mission context: \(coordDirName)/mission.md (background only — wait for your specific assignment before acting).

        COORDINATION PROTOCOL:
        1. Your assignment will be written by the manager to \(file). Do NOT start work until it exists. Block on it first by running:
             i=0; while [ ! -f \(file) ] && [ $i -lt 150 ]; do sleep 2; i=$((i+1)); done
           then read \(file). (If after ~5 min it still isn't there, the manager may be unavailable — only then fall back to mission.md and use your best judgment.)
        2. Do exactly what \(file) says, staying strictly within your assigned scope. The manager owns the big picture; you own your slice.
        3. Post progress and results to \(outbox) (append timestamped updates) so the manager can see them.
        4. After each unit of work, re-read \(file) for any new "## UPDATE" sections from the manager and follow the latest instructions.
        5. If you're blocked or the assignment is unclear, write the question to \(outbox) and wait for the manager to update \(file) — don't guess past it.

        Start by blocking on and reading your assignment.
        """
    }

    private func soloWorkerPrompt(_ mission: String, number: Int, total: Int) -> String {
        guard total > 1 else { return mission }
        return mission + "\n\n(You are worker \(number) of \(total) working on this in parallel with sibling agents in the same project. Pursue your own approach and don't assume the others' progress.)"
    }

    /// Distinct working directories of agents we're currently watching — handy
    /// one-tap targets for launching a new fleet where you're already working.
    var knownDirs: [String] {
        var seen = Set<String>(); var out: [String] = []
        for run in agents where !run.workingDir.isEmpty {
            if seen.insert(run.workingDir).inserted { out.append(run.workingDir) }
        }
        return out
    }

    // MARK: Discovery loop

    private func tick() {
        let now = Date()
        var seen = Set<String>()

        for (path, mtime) in recentTranscripts() {
            let sid = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
            if suppressed.contains(sid) { continue }
            seen.insert(sid)

            let run: AgentRun
            if let existing = byId[sid] {
                run = existing
            } else {
                run = AgentRun(sessionId: sid, transcriptPath: path)
                byId[sid] = run
                agents.append(run)
            }
            run.lastModified = mtime
            tail(run)
            updateStatus(run, now: now)
        }

        // Drop sessions that fell out of the discovery window.
        let stale = agents.filter { !seen.contains($0.sessionId) }
        for run in stale { byId.removeValue(forKey: run.sessionId) }
        if !stale.isEmpty { agents.removeAll { !seen.contains($0.sessionId) } }

        // Kick off a liveness scan; it reaps departed sessions on completion.
        refreshLivenessIfNeeded()

        sortAgents()
        detectTransitions()
        recomputeSummary()
    }

    // MARK: Fleet summary & notifications

    private func recomputeSummary() {
        var s = FleetSummary()
        for run in agents {
            s.total += 1
            switch run.status {
            case .active: s.active += 1
            case .idle:   s.idle += 1; if run.wasActive { s.attention += 1 }
            case .done:   s.done += 1
            }
            s.totalCost += run.costUSD
            s.totalTurns += run.numTurns
            s.totalTokens += run.totalTokens
            s.outputTokens += run.outputTokens
            // Only running agents can be actively burning right now.
            if run.status == .active { s.tokensPerSec += run.tokensPerSec() }
        }
        if s != summary { summary = s }
    }

    /// Watch each agent's status edge-to-edge and fire a single desktop
    /// notification when something worth looking up from your work happens:
    /// an agent finishes, goes quiet waiting on you, or a new one spins up.
    private func detectTransitions() {
        for run in agents {
            let prev = lastNotifiedStatus[run.sessionId]

            if prev == nil && !knownSessions.contains(run.sessionId) {
                knownSessions.insert(run.sessionId)
                if settings.notifyOnStart, !run.prompt.isEmpty {
                    Notifier.shared.post(
                        title: "🤖 Agent started",
                        subtitle: run.folderName,
                        body: run.prompt,
                        sound: false,
                        dedupeKey: "start-\(run.sessionId)")
                }
            }

            if run.status == .active { run.wasActive = true }

            // Only notify on a genuine edge between two observed states — never
            // for whatever status a session happens to be in when first seen
            // (avoids a launch-time burst for sessions that already finished).
            if let prev = prev, prev != run.status {
                if run.status == .done { fireCelebration() }   // 🎉
                switch run.status {
                case .done where settings.notifyOnFinish:
                    Notifier.shared.post(
                        title: "✅ Agent finished",
                        subtitle: run.folderName,
                        body: run.prompt.isEmpty ? "Session complete" : run.prompt,
                        sound: settings.playSound,
                        dedupeKey: "done-\(run.sessionId)")
                case .idle where settings.notifyOnWaiting && prev == .active:
                    // Was working, now quiet — most often waiting for your input.
                    Notifier.shared.post(
                        title: "⏸️ Agent needs you",
                        subtitle: run.folderName,
                        body: run.activity.isEmpty ? "Waiting for input" : run.activity,
                        sound: settings.playSound,
                        dedupeKey: "wait-\(run.sessionId)")
                default:
                    break
                }
            }
            lastNotifiedStatus[run.sessionId] = run.status
        }
        // Forget sessions that have gone away so a recycled id can notify again.
        let live = Set(agents.map { $0.sessionId })
        lastNotifiedStatus = lastNotifiedStatus.filter { live.contains($0.key) }
        knownSessions.formIntersection(live)
    }

    /// Trigger the confetti, then clear it so the celebration's TimelineView
    /// unmounts and stops ticking once the ~1.5s burst is over.
    private func fireCelebration() {
        let now = Date()
        lastFinishAt = now
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.7) { [weak self] in
            if self?.lastFinishAt == now { self?.lastFinishAt = nil }
        }
    }

    /// Send one message to every agent whose terminal we can drive. Returns the
    /// number actually delivered.
    @discardableResult
    func broadcast(_ text: String) -> Int {
        var sent = 0
        for run in agents where (run.terminal?.controllable ?? false) {
            if case .sent = send(text, to: run) { sent += 1 }
        }
        return sent
    }

    private func recentTranscripts() -> [(String, Date)] {
        let fm = FileManager.default
        guard let projects = try? fm.contentsOfDirectory(atPath: projectsDir) else { return [] }
        let cutoff = Date().addingTimeInterval(-discoveryWindow)
        var result: [(String, Date)] = []
        for proj in projects {
            let dir = "\(projectsDir)/\(proj)"
            guard let files = try? fm.contentsOfDirectory(atPath: dir) else { continue }
            for file in files where file.hasSuffix(".jsonl") {
                let path = "\(dir)/\(file)"
                guard let attrs = try? fm.attributesOfItem(atPath: path),
                      let mtime = attrs[.modificationDate] as? Date,
                      mtime >= cutoff else { continue }
                result.append((path, mtime))
            }
        }
        return result
    }

    private func updateStatus(_ run: AgentRun, now: Date) {
        let recentlyWrote = now.timeIntervalSince(run.lastModified) < activeWindow

        // "Finished" has two forms, and both beat transcript recency:
        //  1. the process has exited (one-shot run, or the user quit it), or
        //  2. the last turn ended with end_turn — the agent handed control back
        //     and is waiting for you, even though its REPL stays alive.
        // Without (2), an interactive agent that just finished reads as "Working"
        // until its final message ages out — the exact "says it's still running"
        // complaint. Only an agent that's alive AND mid-turn is Working.
        let exited = liveScanReady && !run.workingDir.isEmpty && !run.processAlive
        if exited || run.turnEnded {
            run.status = .done
        } else if recentlyWrote {
            run.status = .active
        } else {
            run.status = .idle
        }
    }

    private func sortAgents() {
        func rank(_ s: AgentStatus) -> Int { s == .active ? 0 : (s == .idle ? 1 : 2) }
        agents.sort {
            rank($0.status) != rank($1.status)
                ? rank($0.status) < rank($1.status)
                : $0.lastModified > $1.lastModified
        }
    }

    // MARK: Transcript tailing

    private func tail(_ run: AgentRun) {
        guard let fh = try? FileHandle(forReadingFrom: URL(fileURLWithPath: run.transcriptPath)) else { return }
        defer { try? fh.close() }
        try? fh.seek(toOffset: run.readOffset)
        let newData = fh.readDataToEndOfFile()
        run.readOffset = (try? fh.offset()) ?? run.readOffset
        guard !newData.isEmpty || !run.didInitialParse else { return }
        run.partial.append(newData)

        while let nl = run.partial.firstIndex(of: 0x0A) {
            let lineData = run.partial.subdata(in: run.partial.startIndex..<nl)
            run.partial.removeSubrange(run.partial.startIndex...nl)
            if let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] {
                handleEvent(obj, run: run)
            }
        }
        run.didInitialParse = true
    }

    // MARK: Terminal control (delegated to TerminalBridge)

    /// Switch to the agent's terminal tab/pane and bring it to the foreground.
    func focus(_ run: AgentRun) {
        guard let info = run.terminal else { return }
        term.focus(info)
    }

    /// Type `text` into the agent's session and submit it. Scriptable
    /// terminals are targeted exactly by TTY; others fall back to keystrokes.
    @discardableResult
    func send(_ text: String, to run: AgentRun) -> TerminalBridge.SendResult {
        guard let info = run.terminal else { return .failed }
        return term.send(text, to: info)
    }

    // MARK: Event parsing (works on both stream-json and transcript lines)

    private func handleEvent(_ obj: [String: Any], run: AgentRun) {
        if run.workingDir.isEmpty, let cwd = obj["cwd"] as? String, !cwd.isEmpty {
            run.workingDir = cwd
        }
        guard let type = obj["type"] as? String else { return }
        switch type {
        case "assistant":
            guard let message = obj["message"] as? [String: Any],
                  let content = message["content"] as? [[String: Any]] else { return }
            for item in content { handleContentItem(item, run: run) }
            if let usage = message["usage"] as? [String: Any] { recordUsage(usage, run: run) }
            // `tool_use` ⇒ the agent will keep going after the tool returns;
            // `end_turn`/`stop_sequence`/`max_tokens` ⇒ it's finished its turn and
            // is now waiting for you, even though the process stays alive.
            if let reason = message["stop_reason"] as? String {
                run.turnEnded = (reason != "tool_use")
            }

        case "user":
            // Real input or a tool result — either way the agent is working again.
            run.turnEnded = false
            capturePromptIfNeeded(obj, run: run)
            if let message = obj["message"] as? [String: Any],
               let content = message["content"] as? [[String: Any]] {
                for item in content where (item["type"] as? String) == "tool_result" {
                    let text = toolResultText(item)
                    if !text.isEmpty { run.append(LogLine(kind: .result, text: text)) }
                }
            }

        case "result":
            run.sawResult = true
            run.costUSD = (obj["total_cost_usd"] as? Double) ?? run.costUSD
            run.numTurns = (obj["num_turns"] as? Int) ?? run.numTurns

        default:
            break
        }
    }

    /// Fold one assistant turn's token `usage` into the agent's running totals
    /// and burn-rate timeline. Each assistant message reports the usage for that
    /// single API response, so summing across turns gives the true total — and
    /// because we only parse new transcript lines once, nothing is double-counted.
    private func recordUsage(_ usage: [String: Any], run: AgentRun) {
        func int(_ key: String) -> Int { usage[key] as? Int ?? 0 }
        let inp = int("input_tokens")
        let out = int("output_tokens")
        let cacheRead = int("cache_read_input_tokens")
        let cacheCreate = int("cache_creation_input_tokens")
        let delta = inp + out + cacheRead + cacheCreate
        guard delta > 0 else { return }
        run.inputTokens += inp
        run.outputTokens += out
        run.cacheReadTokens += cacheRead
        run.cacheCreateTokens += cacheCreate
        run.recordTokens(delta)
    }

    private func capturePromptIfNeeded(_ obj: [String: Any], run: AgentRun) {
        guard run.prompt.isEmpty, let message = obj["message"] as? [String: Any] else { return }
        if let s = message["content"] as? String {
            run.prompt = firstLine(s)
        } else if let content = message["content"] as? [[String: Any]] {
            for item in content where (item["type"] as? String) == "text" {
                let t = (item["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty { run.prompt = firstLine(t); break }
            }
        }
    }

    private func handleContentItem(_ item: [String: Any], run: AgentRun) {
        guard let itemType = item["type"] as? String else { return }
        if itemType == "thinking" {
            let text = (item["thinking"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            run.activity = "Thinking: " + firstLine(text)
            run.append(LogLine(kind: .status, text: "Thinking: " + firstLine(text)))
            return
        }
        if itemType == "text" {
            let text = (item["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            run.activity = firstLine(text)
            run.append(LogLine(kind: .text, text: text))
            return
        }
        guard itemType == "tool_use", let name = item["name"] as? String else { return }
        let input = item["input"] as? [String: Any] ?? [:]
        if name == "TodoWrite" { applyTodos(input, run: run); return }
        if name == "ExitPlanMode" || name == "exit_plan_mode" { capturePlan(input, run: run); return }
        let summary = toolSummary(name: name, input: input)
        run.activity = summary
        run.append(LogLine(kind: name == "Bash" ? .command : .tool, text: summary))
    }

    /// Stash the markdown plan an agent proposed via ExitPlanMode. Skips an
    /// exact repeat (the same line can be re-parsed) but keeps genuine revisions.
    private func capturePlan(_ input: [String: Any], run: AgentRun) {
        let plan = (input["plan"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !plan.isEmpty, run.plans.last?.text != plan else { return }
        run.plans.append(CapturedPlan(text: plan))
        let rev = run.plans.count
        run.activity = "Proposed a plan" + (rev > 1 ? " (rev \(rev))" : "")
        run.append(LogLine(kind: .status, text: "📋 " + run.activity))
    }

    private func applyTodos(_ input: [String: Any], run: AgentRun) {
        guard let raw = input["todos"] as? [[String: Any]] else { return }
        run.todos = raw.map {
            AgentTodo(content: $0["content"] as? String ?? "",
                      activeForm: $0["activeForm"] as? String ?? "",
                      status: $0["status"] as? String ?? "pending")
        }
        if let active = run.todos.first(where: { $0.status == "in_progress" }) {
            run.activity = active.activeForm.isEmpty ? active.content : active.activeForm
        }
        let done = run.todos.filter { $0.status == "completed" }.count
        run.append(LogLine(kind: .tool, text: "Plan — \(done)/\(run.todos.count) steps done"))
    }

    // MARK: Formatting helpers

    private func toolSummary(name: String, input: [String: Any]) -> String {
        switch name {
        case "Bash":
            let cmd = (input["command"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return cmd.isEmpty ? "Running command" : cmd
        case "Read":  return "Read \(shortPath(input["file_path"]))"
        case "Edit":  return "Edit \(shortPath(input["file_path"]))"
        case "Write": return "Write \(shortPath(input["file_path"]))"
        case "Grep":  return "Search \"\(input["pattern"] as? String ?? "")\""
        case "Glob":  return "Glob \(input["pattern"] as? String ?? "")"
        case "WebFetch":  return "Fetch \(input["url"] as? String ?? "")"
        case "WebSearch": return "Search web: \(input["query"] as? String ?? "")"
        case "Task":  return "Subagent: \(input["description"] as? String ?? "task")"
        default:      return name
        }
    }

    private func toolResultText(_ item: [String: Any]) -> String {
        if let s = item["content"] as? String { return firstLine(s) }
        if let arr = item["content"] as? [[String: Any]] {
            for sub in arr where (sub["type"] as? String) == "text" {
                return firstLine(sub["text"] as? String ?? "")
            }
        }
        return ""
    }

    private func shortPath(_ value: Any?) -> String {
        guard let p = value as? String else { return "" }
        return (p as NSString).lastPathComponent
    }

    private func firstLine(_ s: String) -> String {
        let line = s.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? s
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.count > 160 ? String(trimmed.prefix(160)) + "…" : trimmed
    }
}
