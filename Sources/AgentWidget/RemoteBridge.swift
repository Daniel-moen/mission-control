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
///                  {type:"key", sessionId, key}    named keystroke (menu digit, arrows, ctrl-c, …)
///                  {type:"key", sessionId, text}   literal typing from the remote console, verbatim
///                  {type:"watch", sessionId, hot?} lease: stream that terminal (renewed ~3s;
///                                                  hot ⇒ someone is typing into it, mirror at ~3 Hz)
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
    /// Sessions a viewer is actively TYPING into from the remote console
    /// ({type:"watch", hot:true}): sessionId → expiry. While one is fresh the
    /// mirror runs at ~3 Hz instead of 1 Hz, so typing looks like typing.
    private var hotLeases: [String: Date] = [:]
    private var hotTimer: Timer?
    private var streamSeqs: [String: Int] = [:]
    private var streamLast: [String: String] = [:]
    /// How many delta frames a session has sent since its last full one.
    private var framesSinceFull: [String: Int] = [:]
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
        hotTimer?.invalidate()
        hotTimer = nil
        hotLeases.removeAll()
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
            guard let sid = obj["sessionId"] as? String else { return }
            guard let run = manager.agent(withSessionId: sid) else {
                ack(false, cmd: "key", detail: "That agent is gone"); return
            }
            // Two separate fields on purpose: `key` is a NAME the host maps to
            // bytes ("up", "esc", "ctrl-c"); `text` is literal passthrough from
            // the remote console, typed verbatim. Folding them into one would
            // turn someone typing the word "up" into an arrow key.
            if let text = obj["text"] as? String, !text.isEmpty {
                // Console typing runs at keystroke rate — an ack per character
                // would be broadcast to every viewer, so only failures speak up.
                if !manager.sendRaw(text, to: run) {
                    ack(false, cmd: "key", detail: "Couldn't reach \(run.folderName)'s terminal")
                }
            } else if let key = obj["key"] as? String, !key.isEmpty {
                if manager.sendKey(key, to: run) {
                    ack(true, cmd: "key", detail: "Sent to \(run.folderName)")
                } else {
                    ack(false, cmd: "key", detail: "Couldn't reach \(run.folderName)'s terminal")
                }
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
            // A lease taken from cold means someone just opened this terminal:
            // forget what the last watcher had so the whole buffer is resent,
            // even if nothing on screen has moved since.
            if (watchLeases[sid] ?? .distantPast) < Date() {
                streamLast[sid] = nil
                framesSinceFull[sid] = Self.fullScreenEvery
            }
            watchLeases[sid] = Date().addingTimeInterval(8)
            // `hot` = someone is TYPING into this terminal from the remote
            // console, so 1 Hz isn't enough. Only ever extended here, never
            // cleared: a second viewer holding a plain lease on the same session
            // mustn't knock the console back down to the slow cadence.
            if obj["hot"] as? Bool == true {
                hotLeases[sid] = Date().addingTimeInterval(6)
                syncHotTimer()
            }

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
            guard let launchDir = resolvedDir(dir) else {
                ack(false, cmd: "launch", detail: "No such folder: \(dir)"); return
            }
            let plan = AgentManager.FleetPlan(
                mission: mission, dir: launchDir,
                managerModel: managerModel, workerModels: workerModels, planMode: planMode)
            manager.launchFleet(plan)
            if !launchDir.isEmpty { settings.lastLaunchDir = launchDir }
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
            // Before the stub, not after: a doc seeded for an agent that can never
            // launch sits in the library reading `active` — "research in progress" —
            // for as long as anyone cares to wait for it.
            guard let researchDir = resolvedDir(rdir) else {
                ack(false, cmd: "research", detail: "No such folder: \(rdir)"); return
            }
            let title = subject.isEmpty ? topic : "\(subject) — \(topic)"
            // Seed the file now so it appears in the library as `active` the
            // instant the agent starts, and so the agent has a path to write to.
            let stub = "# \(title)\n\n_Research in progress…_\n"
            guard let id = DocLibrary.shared.create(
                title: title, kind: .research, status: .active,
                subject: subject, tags: tags, dir: researchDir, body: stub) else {
                ack(false, cmd: "research", detail: "Couldn't start the research"); return
            }
            let plan = AgentManager.FleetPlan(
                mission: researchMission(topic: topic, subject: subject,
                                         id: id, path: DocLibrary.shared.path(of: id)),
                dir: researchDir, managerModel: nil, workerModels: [model], planMode: false)
            manager.launchFleet(plan)
            if !researchDir.isEmpty { settings.lastLaunchDir = researchDir }
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

    /// `dir` back, once we know a shell can actually `cd` into it — nil if it
    /// names nothing, or names a file. An agent launches as `cd <dir> && claude`,
    /// so a folder that doesn't exist short-circuits the `&&` and no agent ever
    /// starts. Nothing downstream notices: the terminal window opens either way,
    /// and a remote caller has already been told its work is under way. Catch it
    /// here, while the ack can still carry the bad news.
    private func resolvedDir(_ dir: String) -> String? {
        guard !dir.isEmpty else { return dir }   // empty ⇒ the agent's home directory
        var path = (dir as NSString).expandingTildeInPath
        // Resolve a relative dir against home, not against the app's own cwd —
        // which under launchd is `/`, where nothing the user might type exists.
        // The dir travels onward unexpanded either way; this only decides whether
        // to believe in it.
        if !path.hasPrefix("/") { path = (NSHomeDirectory() as NSString).appendingPathComponent(path) }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir),
              isDir.boolValue else { return nil }
        return dir
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
        // A viewer that just arrived holds no baseline, so a delta frame would be
        // meaningless to it — drop every remembered buffer so the next capture
        // resends whole screens.
        if n > viewerCount { resetStreamBaselines() }
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
                self.framesSinceFull = self.framesSinceFull.filter { liveIds.contains($0.key) }
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
                    let prev = self.streamLast[sid]
                    guard text != prev else { continue }
                    self.streamLast[sid] = text
                    let seq = (self.streamSeqs[sid] ?? 0) + 1
                    self.streamSeqs[sid] = seq
                    self.sendScreen(sid: sid, seq: seq, text: text, prev: prev)
                }
            }
        }
    }

    /// A viewer that joins mid-stream (or misses a frame) can't apply a delta, so
    /// a full frame has to come round regularly for it to catch up.
    private static let fullScreenEvery = 8

    /// Forget every remembered buffer, so the next capture of each watched
    /// session sends a whole screen rather than a delta nobody can apply.
    private func resetStreamBaselines() {
        streamLast.removeAll()
        framesSinceFull.removeAll()
    }

    /// Push one {type:"screen"} frame. Terminal output is mostly append-only, so
    /// when the new buffer shares a long prefix with the one the viewer already
    /// holds we send only the tail, plus `keep` — how many leading UTF-16 units of
    /// the previous frame still stand. Typing at 3 Hz then costs bytes per frame
    /// instead of the whole 64 KB scrollback.
    private func sendScreen(sid: String, seq: Int, text: String, prev: String?) {
        let since = framesSinceFull[sid] ?? Self.fullScreenEvery
        if let prev, since + 1 < Self.fullScreenEvery {
            let units = Array(text.utf16)
            let keep = Self.commonUTF16Prefix(units, Array(prev.utf16))
            // Only worth it when most of the screen is unchanged.
            if keep > units.count / 2 {
                framesSinceFull[sid] = since + 1
                sendJSON(["type": "screen", "sessionId": sid, "seq": seq, "keep": keep,
                          "text": String(decoding: units[keep...], as: UTF16.self)])
                return
            }
        }
        framesSinceFull[sid] = 0
        sendJSON(["type": "screen", "sessionId": sid, "seq": seq, "text": text])
    }

    /// Length of the shared leading run, in UTF-16 units (what a JS string index
    /// counts), never splitting a surrogate pair.
    private static func commonUTF16Prefix(_ a: [UInt16], _ b: [UInt16]) -> Int {
        var i = 0
        while i < a.count, i < b.count, a[i] == b[i] { i += 1 }
        if i > 0, (0xD800...0xDBFF).contains(a[i - 1]) { i -= 1 }   // don't cut mid-pair
        return i
    }

    /// The ~3 Hz mirror for terminals being typed into. The timer exists only
    /// while a hot lease is fresh; `captureWatchedIfDue`'s in-flight guard keeps a
    /// slow AppleScript pass from piling up behind itself.
    private func syncHotTimer() {
        let now = Date()
        hotLeases = hotLeases.filter { $0.value > now }
        if hotLeases.isEmpty {
            hotTimer?.invalidate()
            hotTimer = nil
            return
        }
        guard hotTimer == nil else { return }
        let t = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
            guard let self else { return }
            guard self.connected, self.hotLeases.contains(where: { $0.value > Date() }) else {
                self.syncHotTimer()   // expired or disconnected — stand the timer down
                return
            }
            self.captureWatchedIfDue()
        }
        RunLoop.main.add(t, forMode: .common)
        hotTimer = t
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
