import Foundation
import Combine

/// Mirrors the fleet to the remote relay (deployed on Railway) over an
/// outbound WebSocket, so the panel on another device — the iPad — can watch
/// live progress and steer agents. The Mac dials out; nothing ever connects in.
///
/// Protocol (JSON text frames):
///   host → relay:  {type:"snapshot", …}            full fleet state, ~1/s
///                  {type:"screen", sessionId, seq, text}  watched terminal buffer, ~1/s
///                  {type:"ack", ok, cmd, detail, id?}     result of an executed command
///                  {type:"doc", id, …, content}    one document's body, sent on demand
///                  {type:"docSearchResult", q, hits}      library full-text search hits
///   relay → host:  {type:"reply", sessionId, text} type into that agent's terminal
///                  {type:"broadcast", text}        send to every controllable agent
///                  {type:"kill", sessionId}        terminate that agent's process
///                  {type:"key", sessionId, key}    raw keystroke (menu digit, arrows, …)
///                  {type:"watch", sessionId}       lease: stream that terminal (renewed ~3s)
///                  {type:"launch", mission, dir, managerModel?, workerModels[], docId?, docMode?}
///                  {type:"research", topic, subject, dir, model, tags[]}  seed a doc, dispatch an agent to fill it
///                  {type:"docGet|docSave|docCreate|docDelete|docMeta|docSearch", …}  document library
///                  {type:"viewers", count}         how many panels are watching
final class RemoteBridge: NSObject, ObservableObject, URLSessionWebSocketDelegate {
    @Published private(set) var connected = false
    @Published private(set) var viewerCount = 0

    private weak var manager: AgentManager?
    private let settings = Settings.shared
    /// Our own bridge for reading terminal screens — stateless, so a second
    /// instance alongside AgentManager's is harmless.
    private let term = TerminalBridge()
    /// sessionId → latest captured terminal screen text (viewport tail).
    /// Merged per key, never replaced wholesale — a failed capture keeps the
    /// previous text, so one AppleScript hiccup can't blank a terminal remotely.
    private var screens: [String: String] = [:]
    private var capturingScreens = false
    private var ticksSinceCapture = 0
    /// Watch leases from viewers ({type:"watch", sessionId} — renewed ~3s while
    /// an agent's workspace is open on the panel): sessionId → expiry. While a
    /// lease is fresh, that session's full buffer (with scrollback) streams to
    /// viewers as {type:"screen"} frames at ~1 Hz.
    private var watchLeases: [String: Date] = [:]
    private var streamSeqs: [String: Int] = [:]
    private var streamLast: [String: String] = [:]
    private var capturingWatched = false
    /// Previous host CPU tick counters, for the 1 Hz load delta.
    private var lastCPUTicks: (user: UInt64, system: UInt64, idle: UInt64, nice: UInt64)?
    private var lastCPUPercent = 0.0
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
              let rawObj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rawType = rawObj["type"] as? String,
              let manager else { return }

        // A panel cached before the plan library became the document library
        // still speaks plan*. They are the doc* handlers under old names — a
        // plan is just a document of kind `plan`.
        var obj = rawObj
        var type = rawType
        switch rawType {
        case "planGet":    type = "docGet"
        case "planSave":   type = "docSave"
        case "planDelete": type = "docDelete"
        case "planCreate": type = "docCreate"; if obj["kind"] == nil { obj["kind"] = "plan" }
        default: break
        }

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

        case "key":
            guard let sid = obj["sessionId"] as? String,
                  let key = obj["key"] as? String, !key.isEmpty else { return }
            guard let run = manager.agent(withSessionId: sid) else {
                ack(false, cmd: "key", detail: "That agent is gone"); return
            }
            if manager.sendKey(key, to: run) {
                ack(true, cmd: "key", detail: "Sent to \(run.folderName)")
            } else {
                ack(false, cmd: "key", detail: "Couldn't reach \(run.folderName)'s terminal")
            }

        case "kill":
            guard let sid = obj["sessionId"] as? String,
                  let run = manager.agent(withSessionId: sid) else {
                ack(false, cmd: "kill", detail: "That agent is gone"); return
            }
            let name = run.folderName
            manager.destroy(run)
            ack(true, cmd: "kill", detail: "Killed the agent in \(name)")

        case "watch":
            // A lease, not a user action — no ack. Renewed continuously while
            // a panel has that agent's terminal open; expires on its own.
            guard let sid = obj["sessionId"] as? String, !sid.isEmpty else { return }
            watchLeases[sid] = Date().addingTimeInterval(8)

        case "launch":
            var mission = ((obj["mission"] as? String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            var dir = (obj["dir"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            // An attached document from the library: fold its body into the
            // mission (plus the file's path, so agents can re-read or update
            // it), and let it stand in for a missing mission/dir. `planId` is the
            // legacy spelling of a build-mode docId.
            let docId = (obj["docId"] as? String) ?? (obj["planId"] as? String)
            let docMode = (obj["docMode"] as? String) ?? "build"
            if let docId, !docId.isEmpty {
                guard let body = DocLibrary.shared.body(of: docId),
                      let meta = DocLibrary.shared.meta(of: docId) else {
                    ack(false, cmd: "launch", detail: "That document is gone"); return
                }
                if dir.isEmpty { dir = meta.dir }
                let path = DocLibrary.shared.path(of: docId)
                if docMode == "continue" {
                    if mission.isEmpty { mission = "Pick up and keep working on: \(meta.title)" }
                    mission += """


                    ## Attached document — \(meta.title)
                    Here is an existing document from the library. Pick it up and keep working on it — extend, correct, and deepen it, then write the updated version back to that same file, preserving its `---` frontmatter block verbatim. It is saved at \(path).

                    \(body)
                    """
                } else {
                    if mission.isEmpty { mission = "Implement the attached plan: \(meta.title)" }
                    mission += """


                    ## Attached plan — \(meta.title)
                    A reviewed implementation plan for this mission. Follow it. It is saved at \(path) — if you knowingly deviate from it, update that file so it stays true.

                    \(body)
                    """
                }
            }
            guard !mission.isEmpty else {
                ack(false, cmd: "launch", detail: "Mission is empty"); return
            }
            let managerModel = obj["managerModel"] as? String   // nil ⇒ no manager
            let workerModels = (obj["workerModels"] as? [String]) ?? []
            let planMode = obj["planMode"] as? Bool ?? false
            guard managerModel != nil || !workerModels.isEmpty else {
                ack(false, cmd: "launch", detail: "No agents in the plan"); return
            }
            let plan = AgentManager.FleetPlan(
                mission: mission, dir: dir,
                managerModel: managerModel, workerModels: workerModels, planMode: planMode)
            manager.launchFleet(plan)
            if !dir.isEmpty { settings.lastLaunchDir = dir }
            let n = plan.agentCount
            ack(true, cmd: "launch",
                detail: n == 1 ? "Agent launching on your Mac" : "Launching \(n) agents on your Mac")

        case "research":
            let topic = ((obj["topic"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !topic.isEmpty else {
                ack(false, cmd: "research", detail: "Research topic is empty"); return
            }
            let subject = ((obj["subject"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let rdir = ((obj["dir"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let model = (obj["model"] as? String) ?? ""   // "" ⇒ CLI default
            let tags = (obj["tags"] as? [String]) ?? []
            let title = subject.isEmpty ? topic : "\(subject) — \(topic)"
            // Seed the file now so it appears in the library as `active` the
            // instant the agent starts, and so the agent has a path to write to.
            let stub = "# \(title)\n\n_Research in progress…_\n"
            guard let id = DocLibrary.shared.create(
                title: title, kind: .research, status: .active,
                subject: subject, tags: tags, dir: rdir, body: stub) else {
                ack(false, cmd: "research", detail: "Couldn't start the research"); return
            }
            let plan = AgentManager.FleetPlan(
                mission: researchMission(topic: topic, subject: subject,
                                         id: id, path: DocLibrary.shared.path(of: id)),
                dir: rdir, managerModel: nil, workerModels: [model], planMode: false)
            manager.launchFleet(plan)
            if !rdir.isEmpty { settings.lastLaunchDir = rdir }
            sendJSON(["type": "ack", "ok": true, "cmd": "research",
                      "detail": "Researching on your Mac", "id": id])

        // ---- document library ---------------------------------------------
        // Markdown files in ~/.mission-control/library/. The snapshot carries
        // their metadata; bodies travel on demand as {type:"doc"}.

        case "docGet":
            guard let id = obj["id"] as? String, DocLibrary.shared.meta(of: id) != nil else {
                ack(false, cmd: "docGet", detail: "That document is gone"); return
            }
            sendDoc(id)

        case "docSave":
            guard let id = obj["id"] as? String,
                  let content = obj["content"] as? String else {
                ack(false, cmd: "docSave", detail: "Nothing to save"); return
            }
            if DocLibrary.shared.save(id: id, body: content) {
                ack(true, cmd: "docSave", detail: "Document saved")
            } else {
                ack(false, cmd: "docSave", detail: "Couldn't save that document")
            }

        case "docCreate":
            let title = ((obj["title"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let kind = (obj["kind"] as? String).map(DocLibrary.Kind.init(loose:)) ?? .note
            let subject = (obj["subject"] as? String) ?? ""
            let tags = (obj["tags"] as? [String]) ?? []
            let ddir = ((obj["dir"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let content = (obj["content"] as? String) ?? ""
            guard let id = DocLibrary.shared.create(
                title: title, kind: kind, subject: subject, tags: tags, dir: ddir, body: content) else {
                ack(false, cmd: "docCreate", detail: "Couldn't create the document"); return
            }
            // The ack carries the id so the panel can open the fresh document.
            sendJSON(["type": "ack", "ok": true, "cmd": "docCreate", "detail": "Document created", "id": id])
            sendDoc(id)

        case "docDelete":
            guard let id = obj["id"] as? String, DocLibrary.shared.delete(id: id) else {
                ack(false, cmd: "docDelete", detail: "That document is already gone"); return
            }
            ack(true, cmd: "docDelete", detail: "Document deleted")

        case "docMeta":
            guard let id = obj["id"] as? String else {
                ack(false, cmd: "docMeta", detail: "No document"); return
            }
            // Only keys actually present move; an absent key leaves that field
            // as it is on disk (update() reads nil as "leave alone").
            let ok = DocLibrary.shared.update(
                id: id,
                kind: (obj["kind"] as? String).map(DocLibrary.Kind.init(loose:)),
                status: (obj["status"] as? String).map(DocLibrary.Status.init(loose:)),
                subject: obj["subject"] as? String,
                tags: obj["tags"] as? [String],
                dir: obj["dir"] as? String)
            ack(ok, cmd: "docMeta", detail: ok ? "Updated" : "Couldn't update that document")

        case "docSearch":
            let q = ((obj["q"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let hits: [[String: Any]] = DocLibrary.shared.search(q).map {
                ["id": $0.meta.id, "snippets": $0.snippets]
            }
            sendJSON(["type": "docSearchResult", "q": q, "hits": hits])

        default:
            break
        }
    }

    /// Ship one document's full body to the panel. Silently drops if the id
    /// went stale between request and read.
    private func sendDoc(_ id: String) {
        guard let meta = DocLibrary.shared.meta(of: id),
              let body = DocLibrary.shared.body(of: id) else { return }
        sendJSON(["type": "doc", "id": id, "title": meta.title,
                  "kind": meta.kind.rawValue, "status": meta.status.rawValue,
                  "subject": meta.subject, "tags": meta.tags, "dir": meta.dir,
                  "content": body, "updatedAt": meta.updatedAt.timeIntervalSince1970])
    }

    /// The brief handed to a research agent: research the topic and overwrite the
    /// seeded file with a standalone report, keeping the frontmatter and marking
    /// the doc done when finished.
    private func researchMission(topic: String, subject: String, id: String, path: String) -> String {
        let subjectLine = subject.isEmpty ? "" : "\nSubject: \(subject)"
        return """
        You are a research agent. Research the topic below thoroughly and write a report.

        Topic: \(topic)\(subjectLine)

        Research deeply — search the web, and read local code or context in the working directory wherever it bears on the topic. Cross-check what you find.

        Write the FULL report as markdown into this exact file, replacing its placeholder body but PRESERVING the `---` frontmatter block at the very top of the file verbatim (do not touch or drop those lines):
          \(path)

        The report must stand on its own for a reader who never saw this prompt: open with a `#` title, then an executive summary, then well-structured sections. State concrete facts, and cite sources with links wherever you have them. End with a "Sources" section.

        When the report is written, mark the document done by running:
          ~/.mission-control/bin/mc-doc set \(id) status done
        If that command isn't installed, edit the `status:` line in the file's frontmatter to `status: done` yourself.
        """
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
        let liveIds = Set(manager.agents.map { $0.sessionId })
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var captured: [String: String] = [:]
            for (sid, info) in targets {
                guard let raw = self?.term.screenText(of: info) else { continue }
                captured[sid] = Self.trimScreen(raw)
            }
            DispatchQueue.main.async {
                guard let self else { return }
                // Merge — a session whose capture failed this pass keeps its
                // last good screen instead of going blank on the panel.
                for (sid, text) in captured { self.screens[sid] = text }
                self.screens = self.screens.filter { liveIds.contains($0.key) }
                self.streamSeqs = self.streamSeqs.filter { liveIds.contains($0.key) }
                self.streamLast = self.streamLast.filter { liveIds.contains($0.key) }
                self.capturingScreens = false
            }
        }
    }

    /// Stream watched sessions at full tick rate: capture the whole buffer
    /// (scrollback included) of every session holding a fresh lease and push a
    /// {type:"screen", sessionId, seq, text} frame when it changed. Runs on its
    /// own flag so a slow all-agents pass can't starve the open workspace.
    private func captureWatchedIfDue() {
        guard let manager else { return }
        let now = Date()
        if !watchLeases.isEmpty { watchLeases = watchLeases.filter { $0.value > now } }
        guard !watchLeases.isEmpty, !capturingWatched else { return }
        let targets: [(String, TerminalInfo)] = manager.agents.compactMap { run in
            guard watchLeases[run.sessionId] != nil,
                  let info = run.terminal, info.scriptable else { return nil }
            return (run.sessionId, info)
        }
        guard !targets.isEmpty else { return }
        capturingWatched = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var captured: [String: String] = [:]
            for (sid, info) in targets {
                guard let raw = self?.term.screenText(of: info, scrollback: true) else { continue }
                captured[sid] = Self.trimBuffer(raw)
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.capturingWatched = false
                for (sid, text) in captured {
                    self.screens[sid] = Self.trimScreen(text)   // snapshot rides along
                    guard text != self.streamLast[sid] else { continue }
                    self.streamLast[sid] = text
                    let seq = (self.streamSeqs[sid] ?? 0) + 1
                    self.streamSeqs[sid] = seq
                    self.sendJSON(["type": "screen", "sessionId": sid, "seq": seq, "text": text])
                }
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

    /// Same idea for the streamed full buffer — generous (scrollback is the
    /// point) but still bounded so one frame can't be megabytes.
    private static func trimBuffer(_ raw: String) -> String {
        var lines = raw.components(separatedBy: "\n")
        while let last = lines.last, last.trimmingCharacters(in: .whitespaces).isEmpty {
            lines.removeLast()
        }
        let tail = lines.suffix(400).joined(separator: "\n")
        return tail.count > 65536 ? String(tail.suffix(65536)) : tail
    }

    private func pushSnapshot() {
        guard connected, let manager else { return }
        captureScreensIfDue()
        captureWatchedIfDue()
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
        sendJSON(["type": "ack", "ok": ok, "cmd": cmd, "detail": detail])
    }

    private func sendJSON(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }

    // MARK: Host system stats

    /// Whole-machine CPU busy % since the previous call (~1 Hz), from the
    /// kernel's aggregate tick counters — no subprocess, microseconds of work.
    private func hostCPUPercent() -> Double {
        var size = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info_data_t>.stride
                                          / MemoryLayout<integer_t>.stride)
        var info = host_cpu_load_info_data_t()
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(size)) {
                host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, $0, &size)
            }
        }
        guard kr == KERN_SUCCESS else { return lastCPUPercent }
        let t = (user: UInt64(info.cpu_ticks.0), system: UInt64(info.cpu_ticks.1),
                 idle: UInt64(info.cpu_ticks.2), nice: UInt64(info.cpu_ticks.3))
        defer { lastCPUTicks = t }
        guard let p = lastCPUTicks,
              t.user >= p.user, t.system >= p.system, t.idle >= p.idle, t.nice >= p.nice
        else { return lastCPUPercent }
        let busy = (t.user - p.user) + (t.system - p.system) + (t.nice - p.nice)
        let total = busy + (t.idle - p.idle)
        guard total > 0 else { return lastCPUPercent }
        lastCPUPercent = Double(busy) / Double(total) * 100
        return lastCPUPercent
    }

    /// Physical memory in use (active + wired + compressed), MB.
    private func hostMemUsedMB() -> Double {
        var size = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.stride
                                          / MemoryLayout<integer_t>.stride)
        var stats = vm_statistics64_data_t()
        let kr = withUnsafeMutablePointer(to: &stats) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(size)) {
                host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &size)
            }
        }
        guard kr == KERN_SUCCESS else { return 0 }
        let pages = Double(stats.active_count) + Double(stats.wire_count)
            + Double(stats.compressor_page_count)
        return pages * Double(vm_kernel_page_size) / 1_048_576
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
                "pid": Int(run.pid),
                "cpu": (run.cpuPercent * 10).rounded() / 10,
                "mem": Int(run.memMB.rounded()),
                "branch": run.branch,
                "alive": run.processAlive,
                "name": run.agentName,
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
            // Whole-machine health for the panel's status strip. Rounded so a
            // quiet fleet still dedups identical frames most of the time.
            "system": [
                "cpu": Int(hostCPUPercent().rounded()),
                "cores": ProcessInfo.processInfo.activeProcessorCount,
                "memUsedMB": Int(hostMemUsedMB().rounded()),
                "memTotalMB": Int((Double(ProcessInfo.processInfo.physicalMemory) / 1_048_576).rounded()),
            ],
            // The document library (metadata only — bodies travel via docGet).
            "docs": DocLibrary.shared.list().map {
                ["id": $0.id, "title": $0.title, "kind": $0.kind.rawValue,
                 "status": $0.status.rawValue, "subject": $0.subject, "tags": $0.tags,
                 "dir": $0.dir,
                 "folder": $0.dir.isEmpty ? "" : ($0.dir as NSString).lastPathComponent,
                 "session": $0.session, "preview": $0.preview, "words": $0.words,
                 "created": $0.createdAt.timeIntervalSince1970,
                 "updatedAt": $0.updatedAt.timeIntervalSince1970]
            },
            // Everything the remote Launch tab needs to compose a plan.
            "knownDirs": manager.knownDirs,
            "lastDir": settings.lastLaunchDir,
            "models": ModelChoice.allCases.map {
                ["flag": $0.flag, "label": $0.label, "short": $0.short, "blurb": $0.blurb]
            },
        ]
    }
}
