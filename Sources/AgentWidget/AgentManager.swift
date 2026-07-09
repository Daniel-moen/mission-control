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
    /// Coordinated launches, each grouping several `agents` under one item.
    @Published var fleets: [FleetGroup] = []
    /// Aggregate fleet state, refreshed every tick.
    @Published var summary = FleetSummary()
    /// Set the instant an agent finishes — the UI watches this to fire confetti.
    @Published var lastFinishAt: Date?
    /// Whether the dashboard popover is currently on screen. Drives the poll
    /// cadence: fast while someone's watching the live feed, lazy while hidden so
    /// the constant directory-walk isn't burning CPU for nobody. Tracked by the
    /// AppDelegate via NSPopoverDelegate.
    @Published var popoverVisible: Bool = false {
        didSet {
            guard popoverVisible != oldValue else { return }
            // On open, refresh immediately so the feed isn't stale for up to a
            // full slow-cadence interval, then switch to the matching cadence.
            // Also force a fresh process scan: while closed we let liveness/terminal
            // info go stale to save CPU, so re-resolve it the instant someone looks.
            if popoverVisible {
                lastLivenessScan = .distantPast
                tick()
            }
            scheduleTimer()
        }
    }
    /// True while at least one remote panel (iPad) is watching via RemoteBridge.
    /// Treated like an open popover for polling purposes so the remote feed
    /// reads as live even though the Mac's popover is closed.
    var remoteWatching: Bool = false {
        didSet {
            guard remoteWatching != oldValue else { return }
            if remoteWatching {
                lastLivenessScan = .distantPast
                tick()
            }
            scheduleTimer()
        }
    }
    /// Someone — local popover or remote panel — is actively watching the feed.
    private var watched: Bool { popoverVisible || remoteWatching }

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

    var activeCount: Int { agents.filter { $0.status == .active }.count }

    init() { start() }

    /// Fast cadence while the popover is open so the activity feed reads as live.
    private let openInterval: TimeInterval = 0.7
    /// Lazy cadence while the popover is closed — the menu-bar icon only needs
    /// summary-level freshness when nobody's looking at the feed.
    private let closedInterval: TimeInterval = 4.0

    func start() {
        tick()
        scheduleTimer()
    }

    /// (Re)arm the poll timer at the cadence appropriate for the current popover
    /// visibility. Called on launch and whenever `popoverVisible` flips.
    private func scheduleTimer() {
        timer?.invalidate()
        let interval = watched ? openInterval : closedInterval
        let t = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    // MARK: Liveness & terminal resolution

    private let term = TerminalBridge()
    /// Every running `claude` process from the latest scan, refreshed off the
    /// main thread (a process scan is too heavy per tick). Keyed by PID, joined
    /// with Claude Code's session registry — the source of truth for which
    /// process (and therefore which terminal pane) belongs to which session.
    private var liveProcs: [ClaudeProcess] = []
    private var liveScanReady = false
    private var lastLivenessScan = Date.distantPast
    /// dir → (branch, readAt) cache so we're not re-reading .git/HEAD each pass.
    private var branchCache: [String: (branch: String, at: Date)] = [:]
    /// How often we run the (expensive: lsof + a parent-walk of ps forks per
    /// agent) process scan. Snappy while the popover is open so liveness and
    /// terminal targeting stay fresh for the live feed; much lazier while it's
    /// closed, where terminal info is unusable (no focus/reply UI on screen) and
    /// only coarse liveness matters. This is the app's single biggest idle cost,
    /// so backing it off when nobody's watching is where most of the CPU goes.
    private var livenessScanInterval: TimeInterval { watched ? 2.5 : 12.0 }

    private func refreshLivenessIfNeeded() {
        guard Date().timeIntervalSince(lastLivenessScan) > livenessScanInterval else { return }
        lastLivenessScan = Date()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let procs = self?.term.scan()
            DispatchQueue.main.async {
                // A failed scan (nil) tells us nothing — keep the previous
                // liveness picture and, crucially, don't count misses, or a
                // couple of hiccups under load flip every agent to "done".
                guard let procs else { return }
                self?.liveProcs = procs
                self?.liveScanReady = true
                self?.assignProcesses()
                // Reap once per scan so the miss count tracks real scans,
                // not the much faster UI tick.
                self?.reapDepartedSessions()
            }
        }
    }

    /// Bind each agent to ITS process — never merely "a process in the same
    /// folder". Exact matches come from Claude Code's session registry
    /// (sessionId ↔ pid); processes without a registry entry (older CLI builds)
    /// fall back to sticky per-cwd assignment, oldest process to oldest session,
    /// so even then two same-folder agents get two distinct TTYs.
    private func assignProcesses() {
        var bySession: [String: ClaudeProcess] = [:]
        for p in liveProcs where !p.sessionId.isEmpty { bySession[p.sessionId] = p }

        var unbound: [AgentRun] = []
        for run in agents {
            if let p = bySession[run.sessionId] {
                apply(p, to: run)
            } else {
                unbound.append(run)
            }
        }
        // Pool for the fallback: registry-less processes only. A process that
        // declares a sessionId belongs to that session and no other — handing
        // it to a different agent is exactly the leak this design removes.
        var pool = liveProcs.filter { $0.sessionId.isEmpty }
        guard !unbound.isEmpty else { return }

        // Sticky pass: keep an agent on the pid it already had.
        for run in unbound where run.pid != 0 {
            if let i = pool.firstIndex(where: { $0.pid == run.pid && $0.cwd == resolved(run.workingDir) }) {
                apply(pool[i], to: run)
                pool.remove(at: i)
            } else {
                run.pid = 0
            }
        }
        // Remaining: oldest unclaimed same-cwd process → oldest session.
        for run in unbound where run.pid == 0 {
            guard !run.workingDir.isEmpty else { clearProcess(run); continue }
            let rdir = resolved(run.workingDir)
            let candidates = pool.filter { $0.cwd == rdir }
                .sorted { ($0.startedAt ?? .distantPast) < ($1.startedAt ?? .distantPast) }
            guard let pick = candidates.first else { clearProcess(run); continue }
            apply(pick, to: run)
            pool.removeAll { $0.pid == pick.pid }
        }
    }

    private func apply(_ p: ClaudeProcess, to run: AgentRun) {
        run.pid = p.pid
        run.cpuPercent = p.cpuPercent
        run.memMB = p.rssMB
        run.everBound = true
        if !p.name.isEmpty { run.agentName = p.name }
        if p.terminal != run.terminal { run.terminal = p.terminal }
        if !run.workingDir.isEmpty { run.branch = branch(of: resolved(run.workingDir)) }
    }

    private func clearProcess(_ run: AgentRun) {
        run.pid = 0
        run.cpuPercent = 0
        if run.terminal != nil { run.terminal = nil }
    }

    /// Current git branch of a working directory (via .git/HEAD — no subprocess),
    /// cached briefly so a scan pass touches each repo at most once.
    private func branch(of dir: String) -> String {
        if let hit = branchCache[dir], Date().timeIntervalSince(hit.at) < 15 { return hit.branch }
        var result = ""
        var gitDir = "\(dir)/.git"
        // Worktrees: .git is a file containing "gitdir: <path>".
        if let attrs = try? FileManager.default.attributesOfItem(atPath: gitDir),
           (attrs[.type] as? FileAttributeType) == .typeRegular,
           let content = try? String(contentsOfFile: gitDir, encoding: .utf8),
           let path = content.split(separator: "\n").first(where: { $0.hasPrefix("gitdir:") }) {
            gitDir = String(path.dropFirst(7)).trimmingCharacters(in: .whitespaces)
        }
        if let head = try? String(contentsOfFile: "\(gitDir)/HEAD", encoding: .utf8) {
            let line = head.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix("ref: refs/heads/") {
                result = String(line.dropFirst("ref: refs/heads/".count))
            } else if line.count >= 7 {
                result = String(line.prefix(7))   // detached HEAD → short sha
            }
        }
        branchCache[dir] = (result, Date())
        return result
    }

    private func resolved(_ path: String) -> String {
        (path as NSString).resolvingSymlinksInPath
    }

    /// Remove agents whose claude process has gone away (the user left/quit it).
    /// Conservative on purpose: a session is only dropped after several
    /// consecutive scans confirm no live process for it, and a session that's
    /// still writing its transcript is never touched. Once dropped it's
    /// suppressed so discovery doesn't flicker it back in.
    private func reapDepartedSessions() {
        guard liveScanReady else { return }
        let livePids = Set(liveProcs.map { $0.pid })
        var gone: [AgentRun] = []
        for run in agents where !run.workingDir.isEmpty {
            // The assignment pass just ran, so a live agent has its process
            // bound (pid set and present). The process scan — not transcript
            // recency — is the source of truth for liveness: a live process is
            // Working no matter how long it's been quiet (thinking, long tool
            // call). The recency guard below only papers over scan races.
            if run.pid != 0 && livePids.contains(run.pid) {
                run.livenessMisses = 0
                run.processAlive = true
            } else if Date().timeIntervalSince(run.lastModified) < 15 {
                // The transcript was written moments ago — something is very
                // much alive here, whatever the process scan failed to see.
                run.livenessMisses = 0
                run.processAlive = true
            } else {
                run.livenessMisses += 1
                // Three misses (~8s) to ride out transient per-pid lsof races
                // before we call it dead; several more before removing it.
                if run.livenessMisses >= 3 { run.processAlive = false }
                if run.livenessMisses >= 6 { gone.append(run) }
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

    /// Kill the running agent's own process, then drop it from the monitor.
    /// Targets the bound PID — never "everything in that folder" — so killing
    /// one agent can't take out a sibling working in the same directory.
    func destroy(_ run: AgentRun) {
        if run.pid != 0 {
            kill(run.pid, SIGTERM)
        } else if !run.workingDir.isEmpty {
            // Never bound (scan hasn't landed yet): fall back to cwd matching,
            // but leave alone any process that is bound to another tracked
            // agent or declares a different session in the registry.
            let ownedByOthers = Set(agents.compactMap { other -> Int32? in
                other.sessionId != run.sessionId && other.pid != 0 ? other.pid : nil
            })
            let procs = liveProcs.filter {
                $0.cwd == resolved(run.workingDir)
                    && !ownedByOthers.contains($0.pid)
                    && ($0.sessionId.isEmpty || $0.sessionId == run.sessionId)
            }
            for p in procs { kill(p.pid, SIGTERM) }
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
        /// Launch in Claude Code's read-only "plan mode" (`--permission-mode
        /// plan`) instead of the usual unattended auto mode — the agent explores
        /// and drafts a plan but can't modify code until approved.
        var planMode: Bool = false
    }

    /// Terminals installed on this machine, for the launcher's "open in" picker.
    /// Resolved once — a terminal installed mid-session shows up after a restart.
    lazy var installedTerminals: [TerminalBridge.LaunchTerminal] = term.installedTerminals()

    /// Spin up one fresh `claude` session per spec in the user's chosen terminal,
    /// rooted at `dir` — as tabs of a window it already has open, or as new
    /// windows. We stagger them slightly so a burst of simultaneous launches
    /// doesn't trip the terminal up. They appear in the fleet automatically as
    /// soon as they write their first transcript line.
    func launchSessions(_ specs: [LaunchSpec], in dir: String) {
        let folder = dir.isEmpty ? home : (dir as NSString).expandingTildeInPath
        let terminal = settings.launchTerminal
        let newTab = settings.launchInNewTab
        for (i, spec) in specs.enumerated() {
            let cmd = launchCommand(dir: folder, model: spec.model, prompt: spec.prompt, planMode: spec.planMode)
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 0.5) { [weak self] in
                self?.term.launch(command: cmd, in: terminal, newTab: newTab)
            }
        }
    }

    /// Whether the chosen terminal can host agents in tabs — drives the
    /// launcher's "New tab" toggle, which is meaningless for the ones that can't.
    var launchTerminalSupportsTabs: Bool { term.supportsNewTab(settings.launchTerminal) }

    private func launchCommand(dir: String, model: String, prompt: String, planMode: Bool = false) -> String {
        let q = TerminalBridge.shellQuote
        // A launched agent MUST run as an independent, top-level session. When the
        // app (or the terminal it spawns) was itself started from inside a Claude
        // session, the new shell inherits CLAUDE_CODE_* / CLAUDECODE env vars that
        // put `claude` into nested "child session" mode — in which it writes no
        // discoverable transcript under ~/.claude/projects and never registers in
        // ~/.claude/sessions, so it can never show up in the fleet. Scrub every
        // CLAUDE_CODE* marker first; this is the actual fix for "agents launched
        // from the menu aren't tracked".
        var c = #"unset $(env | sed -n 's/^\(CLAUDE_CODE[A-Za-z_]*\)=.*/\1/p') CLAUDECODE AI_AGENT 2>/dev/null"#
        c += "; cd \(q(dir))"
        c += " && claude"
        if !model.isEmpty { c += " --model \(model)" }
        if planMode {
            // Read-only planning session: the agent can explore and draft a plan
            // but Claude Code gates every code change behind approval, so it stops
            // at the plan and waits rather than implementing. (Never paired with
            // --dangerously-skip-permissions, which would override plan mode.)
            c += " --permission-mode plan"
        } else {
            // Run unattended ("auto mode"): skip per-tool permission prompts so the
            // agent — and coordinated workers' polling loops — start working at once.
            c += " --dangerously-skip-permissions"
        }
        c += " \(q(planMode ? prompt : prompt + Self.planFilePostscript))"
        return c
    }

    /// Read off the library itself rather than hardcoded: the folder has moved
    /// once already (`~/.mission-control/plans` → `.../library`), and an agent
    /// pointed at the old one writes somewhere nothing lists.
    private static var libraryRoot: String {
        (DocLibrary.shared.root as NSString).abbreviatingWithTildeInPath
    }

    /// Only a plan-mode agent gets its plan captured for free (ExitPlanMode →
    /// `capturePlan`). An ordinary agent that decides to write one drops a
    /// `PLAN.md` wherever it happens to be working and the library never sees
    /// it — so point those at the plans folder instead. A bare markdown file
    /// lands there fine: `PlanLibrary` reads the title off the first heading and
    /// treats frontmatter as optional.
    ///
    /// Deliberately NOT appended in plan mode, where it would be actively
    /// harmful: that agent is read-only, so a Write stalls on a permission gate
    /// instead of the agent finishing at ExitPlanMode.
    private static var planFilePostscript: String {
        """


        (Mission Control: if you write a standalone plan or design document as markdown, \
        save it in \(libraryRoot)/ rather than inside the project, so it shows up in the \
        document library. This does not apply to documentation that belongs with the code.)
        """
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
        /// Launch every agent in read-only plan mode (used for the panel's "draft
        /// a plan" flow — a solo agent that plans but never touches code).
        var planMode: Bool = false
        var agentCount: Int { (managerModel == nil ? 0 : 1) + workerModels.count }
    }

    /// Folder, relative to the working dir, that the manager and workers use as
    /// their shared mailbox. Kept relative so the prompts read cleanly.
    private let coordDirName = ".mission-control"

    func launchFleet(_ plan: FleetPlan) {
        let dir = plan.dir.isEmpty ? home : (plan.dir as NSString).expandingTildeInPath
        let coordinated = plan.managerModel != nil
        if coordinated { setupCoordination(dir: dir, mission: plan.mission) }

        // A multi-agent launch is tracked as one expandable group; its members
        // are claimed as their sessions surface (see assignFleetMembership).
        if plan.agentCount >= 2 {
            fleets.append(FleetGroup(mission: plan.mission, dir: dir,
                                     hasManager: coordinated, expectedCount: plan.agentCount))
        }

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
            specs.append(.init(model: wm, prompt: prompt, planMode: plan.planMode))
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

    /// Look up the group a member belongs to.
    func fleet(for id: UUID) -> FleetGroup? { fleets.first { $0.id == id } }

    /// Look up a tracked session by its id — used by RemoteBridge to target
    /// commands arriving from the remote panel.
    func agent(withSessionId id: String) -> AgentRun? { byId[id] }

    /// Currently-tracked members of a fleet, in display order (manager first,
    /// then by status then recency — matching the global sort).
    func members(of fleet: FleetGroup) -> [AgentRun] {
        agents.filter { $0.fleetId == fleet.id }
    }

    /// Correlate freshly discovered sessions to a launched fleet. A session is
    /// claimed when its (symlink-resolved) working dir matches an open fleet's
    /// and it was first seen at/after that launch — so pre-existing agents in the
    /// same folder are never swept in. Fleets that age out without ever gaining a
    /// member, or whose members have all departed, are dropped.
    private func assignFleetMembership(now: Date) {
        guard !fleets.isEmpty else { return }
        for run in agents where run.fleetId == nil && !run.workingDir.isEmpty {
            let rdir = resolved(run.workingDir)
            for fleet in fleets where fleet.resolvedDir == rdir {
                let claimed = agents.lazy.filter { $0.fleetId == fleet.id }.count
                guard fleet.isOpen(now: now, claimed: claimed),
                      run.firstSeen >= fleet.createdAt.addingTimeInterval(-2) else { continue }
                run.fleetId = fleet.id
                break
            }
        }
        fleets.removeAll { fleet in
            let hasMembers = agents.contains { $0.fleetId == fleet.id }
            return !hasMembers && !fleet.isOpen(now: now, claimed: 0)
        }
    }

    private func modelLabel(_ flag: String) -> String {
        switch flag {
        case "claude-fable-5":  return "Fable 5"
        case "opus":            return "Opus"
        case "claude-sonnet-5", "sonnet": return "Sonnet 5"
        case "haiku":           return "Haiku"
        default:                return "Default"
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

        YOUR ROLE IS PURELY ORCHESTRATION. You do NOT write or edit code yourself. You decompose the mission, tell each worker exactly which files to modify and what their task is, watch their progress, course-correct, and reconcile their work into one result. The workers do the hands-on changes; you direct them.

        The mission is recorded in \(coordDirName)/mission.md:

        \(mission)

        Your crew (each running in its own session, already booted and blocked, polling for your orders):
        \(roster)

        COORDINATION PROTOCOL — the workers follow this exact protocol, so use it:
        1. Decompose the mission into clear, self-contained assignments — one per worker. Partition the work so two workers never edit the same file at once.
        2. Write each worker's assignment to \(coordDirName)/worker-<k>.md (e.g. \(coordDirName)/worker-1.md). Be specific: the exact files to touch, the task, constraints, and a clear definition of done. Each worker is BLOCKED until this file appears and will do exactly what it says.
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
            // Only open a FileHandle + seek when the transcript has actually
            // been written since we last read it. An unchanged file has nothing
            // new to parse, so skip the I/O entirely — but a brand-new run that
            // hasn't had its first parse yet must always be tailed once.
            let previousMtime = run.lastModified
            run.lastModified = mtime
            if !run.didInitialParse || mtime > previousMtime {
                tail(run)
            }
            updateStatus(run, now: now)
        }

        // Drop sessions that fell out of the discovery window.
        let stale = agents.filter { !seen.contains($0.sessionId) }
        for run in stale { byId.removeValue(forKey: run.sessionId) }
        if !stale.isEmpty { agents.removeAll { !seen.contains($0.sessionId) } }

        // Kick off a liveness scan; it reaps departed sessions on completion.
        refreshLivenessIfNeeded()

        assignFleetMembership(now: now)
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
        // "Finished" has two forms:
        //  1. the process has exited (one-shot run, or the user quit it), or
        //  2. the last turn ended with end_turn — the agent handed control back
        //     and is waiting for you, even though its REPL stays alive.
        // Transcript recency deliberately plays NO part in this: Claude Code
        // batch-writes transcript lines only when a message or tool call
        // completes, so extended thinking and long tool calls produce silent
        // gaps of many minutes. A live process mid-turn is Working no matter
        // how long it's been quiet — the turn's end, not silence, is the edge
        // that matters. (A transcript written moments ago also proves the
        // process is alive, whatever a flaky liveness scan claims.)
        let exited = liveScanReady && !run.workingDir.isEmpty && !run.processAlive
            && now.timeIntervalSince(run.lastModified) > 15
        if exited || run.turnEnded {
            run.status = .done
        } else if run.interrupted {
            run.status = .idle          // Esc'd mid-turn — waiting for input
        } else {
            run.status = .active
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

    /// Send a single raw keystroke (a digit to pick a menu option, or a named
    /// key like "up"/"down"/"enter"/"esc") to an agent's terminal WITHOUT a
    /// trailing newline — so the panel can drive Claude Code's interactive
    /// selection prompts. Returns whether it reached the terminal.
    @discardableResult
    func sendKey(_ key: String, to run: AgentRun) -> Bool {
        guard let info = run.terminal else { return false }
        return term.sendKey(key, to: info)
    }

    // MARK: Event parsing (works on both stream-json and transcript lines)

    private func handleEvent(_ obj: [String: Any], run: AgentRun) {
        if run.workingDir.isEmpty, let cwd = obj["cwd"] as? String, !cwd.isEmpty {
            run.workingDir = cwd
        }
        guard let type = obj["type"] as? String else { return }
        switch type {
        case "assistant":
            run.interrupted = false
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
            // Not everything recorded as a "user" line is the user talking to
            // the agent. Meta lines (caveats), local commands (/model, /clear)
            // and their stdout, and compaction summaries land in the transcript
            // too — none of them start a turn, so none of them may reset
            // `turnEnded` (that made a finished session read as "Working",
            // then fire a false "needs you" when it decayed).
            if (obj["isMeta"] as? Bool) == true { return }
            if (obj["isCompactSummary"] as? Bool) == true { return }
            let message = obj["message"] as? [String: Any]
            if let s = message?["content"] as? String,
               s.hasPrefix("<command-name>") || s.hasPrefix("<local-command") { return }
            // Esc mid-turn: the turn is over but nothing finished — the agent
            // sits at the prompt waiting for input.
            if isInterruptLine(message) {
                run.turnEnded = false
                run.interrupted = true
                return
            }
            // Real input or a tool result — either way the agent is working again.
            run.turnEnded = false
            run.interrupted = false
            capturePromptIfNeeded(obj, run: run)
            if let content = message?["content"] as? [[String: Any]] {
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

    /// "[Request interrupted by user]" / "… for tool use]" — written as a user
    /// line when Esc is pressed. Content may be a plain string or a block array.
    private func isInterruptLine(_ message: [String: Any]?) -> Bool {
        guard let message else { return false }
        if let s = message["content"] as? String {
            return s.hasPrefix("[Request interrupted")
        }
        if let content = message["content"] as? [[String: Any]] {
            for item in content where (item["type"] as? String) == "text" {
                if (item["text"] as? String ?? "").hasPrefix("[Request interrupted") { return true }
            }
        }
        return false
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
        // Every proposed plan also lands in the on-disk document library as an
        // editable markdown file (revisions from the same session overwrite),
        // so it can be reviewed, edited, and built from the remote panel.
        DocLibrary.shared.capture(plan, session: run.sessionId, dir: run.workingDir,
                                  fallbackTitle: run.prompt.isEmpty ? run.folderName : firstLine(run.prompt))
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
