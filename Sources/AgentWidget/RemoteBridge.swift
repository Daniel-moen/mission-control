import Foundation
import Combine

/// Mirrors the fleet to the remote relay (deployed on Railway) over an
/// outbound WebSocket, so the panel on another device — the iPad — can watch
/// live progress and steer agents. The Mac dials out; nothing ever connects in.
///
/// Protocol (JSON text frames):
///   host → relay:  {type:"snapshot", …}            full fleet state, ~1/s
///                  {type:"ack", ok, cmd, detail}   result of an executed command
///   relay → host:  {type:"reply", sessionId, text} type into that agent's terminal
///                  {type:"broadcast", text}        send to every controllable agent
///                  {type:"kill", sessionId}        terminate that agent's process
///                  {type:"launch", mission, dir, managerModel?, workerModels[]}
///                  {type:"viewers", count}         how many panels are watching
final class RemoteBridge: NSObject, ObservableObject, URLSessionWebSocketDelegate {
    @Published private(set) var connected = false
    @Published private(set) var viewerCount = 0

    private weak var manager: AgentManager?
    private let settings = Settings.shared
    /// Our own bridge for reading terminal screens — stateless, so a second
    /// instance alongside AgentManager's is harmless.
    private let term = TerminalBridge()
    /// sessionId → latest captured terminal screen text.
    private var screens: [String: String] = [:]
    private var capturingScreens = false
    private var ticksSinceCapture = 0
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var snapshotTimer: Timer?
    private var reconnectAttempt = 0
    private var reconnectWork: DispatchWorkItem?
    private var cancellables = Set<AnyCancellable>()
    /// Generation counter so callbacks from an abandoned socket are ignored.
    private var generation = 0

    init(manager: AgentManager) {
        self.manager = manager
        super.init()
        session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)

        // (Re)connect whenever the remote settings change.
        settings.$remoteEnabled
            .combineLatest(settings.$remoteURL, settings.$remoteToken)
            .removeDuplicates { $0 == $1 && $0.1 == $1.1 && $0.2 == $1.2 }
            .debounce(for: .seconds(0.5), scheduler: RunLoop.main)
            .sink { [weak self] _, _, _ in self?.restart() }
            .store(in: &cancellables)
        restart()
    }

    // MARK: Connection lifecycle

    private var endpoint: URL? {
        let raw = settings.remoteURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = settings.remoteToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard settings.remoteEnabled, !raw.isEmpty, !token.isEmpty,
              var comps = URLComponents(string: raw) else { return nil }
        comps.scheme = (comps.scheme == "http" || comps.scheme == "ws") ? "ws" : "wss"
        comps.path = "/ws"
        comps.queryItems = [
            URLQueryItem(name: "role", value: "host"),
            URLQueryItem(name: "token", value: token),
        ]
        return comps.url
    }

    private func restart() {
        disconnect()
        reconnectAttempt = 0
        connect()
    }

    private func connect() {
        guard task == nil, let url = endpoint else { return }
        generation += 1
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        receiveLoop(gen: generation)
    }

    private func disconnect() {
        reconnectWork?.cancel()
        reconnectWork = nil
        snapshotTimer?.invalidate()
        snapshotTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        generation += 1
        if connected { connected = false }
        setViewers(0)
    }

    private func scheduleReconnect() {
        guard endpoint != nil else { return }
        snapshotTimer?.invalidate()
        snapshotTimer = nil
        task?.cancel()
        task = nil
        if connected { connected = false }
        setViewers(0)
        let delay = min(30.0, pow(2.0, Double(min(reconnectAttempt, 5))))
        reconnectAttempt += 1
        let work = DispatchWorkItem { [weak self] in self?.connect() }
        reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    // MARK: URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        guard webSocketTask === task else { return }
        connected = true
        reconnectAttempt = 0
        startSnapshotTimer()
        pushSnapshot()   // don't leave a fresh viewer staring at nothing for a tick
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === task else { return }
        scheduleReconnect()
    }

    // MARK: Receive

    private func receiveLoop(gen: Int) {
        task?.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.generation == gen else { return }
                switch result {
                case .failure:
                    self.scheduleReconnect()
                case .success(let message):
                    if case .string(let text) = message { self.handle(text) }
                    self.receiveLoop(gen: gen)
                }
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String,
              let manager else { return }

        switch type {
        case "viewers":
            setViewers(obj["count"] as? Int ?? 0)

        case "reply":
            guard let sid = obj["sessionId"] as? String,
                  let msg = obj["text"] as? String, !msg.isEmpty else { return }
            guard let run = manager.agent(withSessionId: sid) else {
                ack(false, cmd: "reply", detail: "That agent is gone"); return
            }
            switch manager.send(msg, to: run) {
            case .sent:
                ack(true, cmd: "reply", detail: "Sent to \(run.folderName)")
            case .needsAccessibility:
                ack(false, cmd: "reply", detail: "Mac needs Accessibility permission for this terminal")
            case .failed:
                ack(false, cmd: "reply", detail: "Couldn't reach \(run.folderName)'s terminal")
            }

        case "broadcast":
            guard let msg = obj["text"] as? String, !msg.isEmpty else { return }
            let n = manager.broadcast(msg)
            ack(n > 0, cmd: "broadcast",
                detail: n > 0 ? "Broadcast to \(n) agent\(n == 1 ? "" : "s")" : "No reachable agents")

        case "kill":
            guard let sid = obj["sessionId"] as? String,
                  let run = manager.agent(withSessionId: sid) else {
                ack(false, cmd: "kill", detail: "That agent is gone"); return
            }
            let name = run.folderName
            manager.destroy(run)
            ack(true, cmd: "kill", detail: "Killed the agent in \(name)")

        case "launch":
            guard let mission = (obj["mission"] as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines), !mission.isEmpty else {
                ack(false, cmd: "launch", detail: "Mission is empty"); return
            }
            let dir = (obj["dir"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let managerModel = obj["managerModel"] as? String   // nil ⇒ no manager
            let workerModels = (obj["workerModels"] as? [String]) ?? []
            guard managerModel != nil || !workerModels.isEmpty else {
                ack(false, cmd: "launch", detail: "No agents in the plan"); return
            }
            let plan = AgentManager.FleetPlan(
                mission: mission, dir: dir,
                managerModel: managerModel, workerModels: workerModels)
            manager.launchFleet(plan)
            if !dir.isEmpty { settings.lastLaunchDir = dir }
            let n = plan.agentCount
            ack(true, cmd: "launch",
                detail: n == 1 ? "Agent launching on your Mac" : "Launching \(n) agents on your Mac")

        default:
            break
        }
    }

    private func setViewers(_ n: Int) {
        guard viewerCount != n else { return }
        viewerCount = n
        // Someone is watching remotely — poll like the popover were open so the
        // panel's feed reads as live; drop back when the last viewer leaves.
        manager?.remoteWatching = n > 0
    }

    // MARK: Send

    private func startSnapshotTimer() {
        snapshotTimer?.invalidate()
        let t = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.pushSnapshot()
        }
        RunLoop.main.add(t, forMode: .common)
        snapshotTimer = t
    }

    private var lastSent: String?
    private var lastSentAt = Date.distantPast

    /// Read each agent's terminal screen (AppleScript / wezterm CLI — too slow
    /// for the snapshot path) on a lazier cadence, off the main thread, and only
    /// while someone is actually watching. Results land in `screens` and ride
    /// along with the next snapshot.
    private func captureScreensIfDue() {
        guard viewerCount > 0, let manager else { return }
        ticksSinceCapture += 1
        guard ticksSinceCapture >= 3, !capturingScreens else { return }   // every ~3s
        ticksSinceCapture = 0
        capturingScreens = true
        let targets: [(String, TerminalInfo)] = manager.agents.compactMap { run in
            guard let info = run.terminal, info.scriptable else { return nil }
            return (run.sessionId, info)
        }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var captured: [String: String] = [:]
            for (sid, info) in targets {
                guard let raw = self?.term.screenText(of: info) else { continue }
                captured[sid] = Self.trimScreen(raw)
            }
            DispatchQueue.main.async {
                self?.screens = captured
                self?.capturingScreens = false
            }
        }
    }

    /// Keep the tail of the screen (what's actually on view) and cap the size
    /// so a huge scrollback can't bloat every snapshot frame.
    private static func trimScreen(_ raw: String) -> String {
        var lines = raw.components(separatedBy: "\n")
        // Drop the trailing run of blank lines terminals pad the buffer with.
        while let last = lines.last, last.trimmingCharacters(in: .whitespaces).isEmpty {
            lines.removeLast()
        }
        let tail = lines.suffix(50).joined(separator: "\n")
        return tail.count > 8000 ? String(tail.suffix(8000)) : tail
    }

    private func pushSnapshot() {
        guard connected, let manager else { return }
        captureScreensIfDue()
        // .sortedKeys makes serialization deterministic: Swift randomizes
        // Dictionary key order, so without it every frame looks different — the
        // dedup below never fires (a full snapshot ships every second) and the
        // viewer sees s.models churn, rebuilding the launch selects ~1/s.
        guard let data = try? JSONSerialization.data(withJSONObject: snapshot(of: manager),
                                                     options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return }
        // Skip identical frames, but resend periodically as a keepalive/heartbeat.
        if text == lastSent && Date().timeIntervalSince(lastSentAt) < 10 { return }
        lastSent = text
        lastSentAt = Date()
        task?.send(.string(text)) { [weak self] error in
            if error != nil { DispatchQueue.main.async { self?.scheduleReconnect() } }
        }
    }

    private func ack(_ ok: Bool, cmd: String, detail: String) {
        let obj: [String: Any] = ["type": "ack", "ok": ok, "cmd": cmd, "detail": detail]
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }

    // MARK: Snapshot

    private func snapshot(of manager: AgentManager) -> [String: Any] {
        let s = manager.summary
        var inputTokens = 0, cacheRead = 0, cacheCreate = 0
        for run in manager.agents {
            inputTokens += run.inputTokens
            cacheRead += run.cacheReadTokens
            cacheCreate += run.cacheCreateTokens
        }
        let summary: [String: Any] = [
            "active": s.active, "idle": s.idle, "done": s.done, "total": s.total,
            "attention": s.attention, "totalCost": s.totalCost, "totalTurns": s.totalTurns,
            "totalTokens": s.totalTokens, "outputTokens": s.outputTokens,
            "inputTokens": inputTokens, "cacheReadTokens": cacheRead,
            "cacheCreateTokens": cacheCreate,
            "tokensPerSec": s.tokensPerSec,
        ]
        let agents: [[String: Any]] = manager.agents.map { run in
            let statusKey: String
            switch run.status {
            case .active: statusKey = "active"
            case .idle:   statusKey = "idle"
            case .done:   statusKey = "done"
            }
            var a: [String: Any] = [
                "id": run.sessionId,
                "folder": run.folderName,
                "dir": run.workingDir,
                "prompt": run.prompt,
                "status": statusKey,
                "statusLabel": run.status.label,
                "activity": run.activity,
                "isManager": run.isManager,
                "controllable": run.terminal?.controllable ?? false,
                "cost": run.costUSD,
                "turns": run.numTurns,
                "tokens": run.totalTokens,
                "outputTokens": run.outputTokens,
                "tokensPerSec": run.tokensPerSec(),
                "uptime": run.uptimeLabel,
                "lastActive": run.lastActiveLabel,
                "todos": run.todos.map {
                    ["content": $0.content, "activeForm": $0.activeForm, "status": $0.status]
                },
                "log": run.log.suffix(40).map { line -> [String: Any] in
                    let kind: String
                    switch line.kind {
                    case .text: kind = "text"; case .command: kind = "command"
                    case .tool: kind = "tool"; case .result: kind = "result"
                    case .status: kind = "status"
                    }
                    return ["kind": kind, "text": line.text]
                },
            ]
            if let fleetId = run.fleetId { a["fleetId"] = fleetId.uuidString }
            if let plan = run.latestPlan { a["plan"] = plan.text }
            if let screen = screens[run.sessionId], !screen.isEmpty { a["screen"] = screen }
            return a
        }
        let fleets: [[String: Any]] = manager.fleets.map {
            ["id": $0.id.uuidString, "title": $0.title, "dir": $0.dir, "hasManager": $0.hasManager]
        }
        return [
            "type": "snapshot",
            "at": Date().timeIntervalSince1970,
            "summary": summary,
            "agents": agents,
            "fleets": fleets,
            // Everything the remote Launch tab needs to compose a plan.
            "knownDirs": manager.knownDirs,
            "lastDir": settings.lastLaunchDir,
            "models": ModelChoice.allCases.map {
                ["flag": $0.flag, "label": $0.label, "short": $0.short, "blurb": $0.blurb]
            },
        ]
    }
}
