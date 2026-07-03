import Foundation

/// One step in an agent's plan, mirrored from Claude Code's TodoWrite tool.
struct AgentTodo: Identifiable, Equatable {
    let id = UUID()
    var content: String
    var activeForm: String
    var status: String // "pending" | "in_progress" | "completed"
}

/// A plan an agent proposed via ExitPlanMode — captured verbatim (markdown) the
/// moment it appears in the transcript, so it survives even after the agent
/// blows past it. Agents can revise their plan, so we keep every revision.
struct CapturedPlan: Identifiable, Equatable {
    let id = UUID()
    let text: String
    let at = Date()
}

/// A single line in an agent's live "mini terminal".
struct LogLine: Identifiable, Equatable {
    let id = UUID()
    let kind: Kind
    let text: String
    let at = Date()

    enum Kind { case text, command, tool, result, status }
}

enum AgentStatus: Equatable {
    case active   // transcript updated within the last few seconds
    case idle     // alive but waiting (e.g. for user input) — no recent writes
    case done     // session reported a final result / all steps complete

    var label: String {
        switch self {
        case .active: return "Working"
        case .idle:   return "Idle"
        case .done:   return "Done"
        }
    }
}

/// A coordinated launch tracked as one expandable item in the fleet list.
/// We don't get to know a session's id at launch time — sessions only surface
/// once they write a transcript — so membership is correlated after the fact:
/// a freshly discovered session whose working dir matches this launch's, within
/// a short window, is claimed as a member (see `AgentManager.assignFleetMembership`).
struct FleetGroup: Identifiable, Equatable {
    let id = UUID()
    let mission: String
    let dir: String
    /// True for a manager-led fleet (one manager + workers); false for a
    /// leaderless parallel launch.
    let hasManager: Bool
    /// How many sessions this launch will spin up — the claim ceiling.
    let expectedCount: Int
    let createdAt = Date()

    /// Symlink-resolved working dir, matched against each discovered session's.
    var resolvedDir: String { (dir as NSString).resolvingSymlinksInPath }

    /// A fleet keeps claiming new sessions until it's full or this window lapses,
    /// so a slow-booting agent still lands in its group.
    func isOpen(now: Date, claimed: Int) -> Bool {
        claimed < expectedCount && now.timeIntervalSince(createdAt) < 600
    }

    /// First line of the mission, trimmed — the collapsed row's headline.
    var title: String {
        let line = mission.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? mission
        let t = line.trimmingCharacters(in: .whitespaces)
        return t.count > 90 ? String(t.prefix(90)) + "…" : t
    }
}

/// Live, observed state of one Claude Code session discovered on disk.
final class AgentRun: ObservableObject, Identifiable {
    let sessionId: String
    var id: String { sessionId }
    let firstSeen = Date()

    @Published var workingDir: String = ""
    @Published var prompt: String = ""
    @Published var status: AgentStatus = .active
    /// Set once this session has been claimed into a launched `FleetGroup`. nil
    /// for solo sessions and any agent we merely discovered (not launched here).
    @Published var fleetId: UUID? = nil
    @Published var todos: [AgentTodo] = []
    /// Every plan this agent has proposed, oldest first.
    @Published var plans: [CapturedPlan] = []
    @Published var activity: String = "Starting…"
    @Published var log: [LogLine] = []
    @Published var costUSD: Double = 0
    @Published var numTurns: Int = 0
    // Token consumption, accumulated from each assistant turn's `usage`. These
    // feed the Burn tab — input/output are the real spend, cache is mostly
    // re-read context but we keep it because, well, it burns too.
    @Published var inputTokens = 0
    @Published var outputTokens = 0
    @Published var cacheReadTokens = 0
    @Published var cacheCreateTokens = 0
    @Published var lastModified = Date()
    /// The terminal this agent's process runs in (nil until resolved / if gone).
    @Published var terminal: TerminalInfo? = nil

    // Tailing bookkeeping (managed by AgentManager).
    var transcriptPath: String
    var readOffset: UInt64 = 0
    var partial = Data()
    var didInitialParse = false
    var sawResult = false
    /// The agent's last turn ended with `end_turn`/`stop_sequence` rather than
    /// `tool_use` — i.e. it finished and handed control back to you. This is how
    /// we know an interactive session is "done" even though its `claude` process
    /// stays alive at the prompt. Reset whenever work resumes.
    var turnEnded = false
    /// The user hit Esc mid-turn ("[Request interrupted by user]") — the agent
    /// is alive at the prompt waiting for input, but didn't finish its turn.
    var interrupted = false
    /// True once we've seen this agent actively working. Lets us tell "went
    /// quiet, probably waiting on you" apart from "was idle the whole time".
    var wasActive = false
    /// Consecutive liveness scans where no claude process matched this cwd.
    /// Used to auto-remove a session shortly after the user leaves it.
    var livenessMisses = 0
    /// Whether a running `claude` process for this session's folder was seen in
    /// the most recent scans. Authoritative for status: a session whose process
    /// is gone is never shown as "Working", however recently it wrote. Starts
    /// true so a brand-new session isn't briefly mislabelled before the first
    /// scan lands; confirmed dead only after two consecutive misses.
    var processAlive = true

    init(sessionId: String, transcriptPath: String) {
        self.sessionId = sessionId
        self.transcriptPath = transcriptPath
    }

    /// The most recent plan revision, if the agent ever proposed one.
    var latestPlan: CapturedPlan? { plans.last }

    var completedSteps: Int { todos.filter { $0.status == "completed" }.count }
    var totalSteps: Int { todos.count }

    var progress: Double? {
        guard totalSteps > 0 else { return nil }
        if status == .done { return 1 }
        return Double(completedSteps) / Double(totalSteps)
    }

    /// Whether this session was launched as the fleet's MANAGER — detected from
    /// the seeded prompt so the grouped view can crown it and list it first.
    var isManager: Bool { prompt.hasPrefix("You are the MANAGER") }

    /// Human label for the folder the agent is working in.
    var folderName: String {
        workingDir.isEmpty ? "—" : (workingDir as NSString).lastPathComponent
    }

    /// How long we've been watching this session (since first discovery).
    var uptime: TimeInterval { Date().timeIntervalSince(firstSeen) }

    /// Compact "3m12s" / "1h04m" style duration for the uptime chip.
    var uptimeLabel: String {
        let t = Int(uptime)
        if t < 60 { return "\(t)s" }
        if t < 3600 { return "\(t / 60)m\(String(format: "%02d", t % 60))s" }
        return "\(t / 3600)h\(String(format: "%02d", (t % 3600) / 60))m"
    }

    /// "12s ago" style label for the most recent transcript write.
    var lastActiveLabel: String {
        let t = Int(Date().timeIntervalSince(lastModified))
        if t < 2 { return "just now" }
        if t < 60 { return "\(t)s ago" }
        if t < 3600 { return "\(t / 60)m ago" }
        return "\(t / 3600)h ago"
    }

    /// Total tokens this agent has burned through across every turn.
    var totalTokens: Int { inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens }

    /// (when, howMany) for each token delta — a rolling timeline that drives the
    /// live burn-rate readout and the flame's intensity. Capped + self-expiring.
    var tokenStamps: [(at: Date, n: Int)] = []

    /// Record a fresh chunk of tokens consumed right now.
    func recordTokens(_ n: Int) {
        guard n > 0 else { return }
        tokenStamps.append((Date(), n))
        if tokenStamps.count > 400 { tokenStamps.removeFirst(tokenStamps.count - 400) }
    }

    /// Tokens/second over the trailing `window`, used for the live burn rate.
    func tokensPerSec(window: TimeInterval = 10) -> Double {
        let cut = Date().addingTimeInterval(-window)
        let sum = tokenStamps.reduce(0) { $0 + ($1.at > cut ? $1.n : 0) }
        return Double(sum) / window
    }

    /// Timestamps of recent transcript events, used to drive the live activity
    /// sparkline and the equalizer's amplitude. Capped and self-expiring.
    var eventTimes: [Date] = []

    func append(_ line: LogLine) {
        log.append(line)
        if log.count > 300 { log.removeFirst(log.count - 300) }
        eventTimes.append(line.at)
        if eventTimes.count > 240 { eventTimes.removeFirst(eventTimes.count - 240) }
    }

    /// 0…1 measure of how furiously the agent is working right now (events in
    /// the last few seconds), used to scale the equalizer.
    var intensity: Double {
        let cut = Date().addingTimeInterval(-8)
        let n = eventTimes.reduce(0) { $0 + ($1 > cut ? 1 : 0) }
        return min(1, Double(n) / 6)
    }

    /// Normalised event histogram over the last `window` seconds for the
    /// sparkline — oldest bucket first, each value 0…1.
    func activitySamples(buckets: Int = 30, window: TimeInterval = 75) -> [Double] {
        let now = Date()
        var b = [Double](repeating: 0, count: buckets)
        let span = window / Double(buckets)
        for t in eventTimes {
            let age = now.timeIntervalSince(t)
            guard age >= 0, age <= window else { continue }
            let idx = buckets - 1 - Int(age / span)
            if idx >= 0, idx < buckets { b[idx] += 1 }
        }
        let mx = max(b.max() ?? 1, 1)
        return b.map { $0 / mx }
    }
}
