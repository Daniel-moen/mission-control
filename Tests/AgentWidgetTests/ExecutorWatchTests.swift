import Foundation
import Testing
@testable import AgentWidget

// Shapes copied from real Claude Code 2.1.300 transcripts (task 0244).

private func line(_ json: String) -> [String: Any] {
    try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
}

private func assistant(_ uuid: String, stop: String, text: String = "ok", apiError: Bool = false,
                       at: String = "2026-10-16T11:41:55.000Z") -> [String: Any] {
    var o: [String: Any] = ["type": "assistant", "uuid": uuid, "timestamp": at,
                            "message": ["role": "assistant", "stop_reason": stop,
                                        "content": [["type": "text", "text": text]]]]
    if apiError { o["isApiErrorMessage"] = true }
    return o
}

/// What Claude Code writes after a turn really ends.
private let closed: [String: Any] = ["type": "system", "subtype": "turn_duration", "durationMs": 30317]

private let bgLaunch = line(#"""
{"type":"user","uuid":"u1","timestamp":"2026-10-16T11:41:54.162Z",
 "message":{"role":"user","content":[{"tool_use_id":"toolu_013","type":"tool_result",
   "content":"Command running in background with ID: b8lp59xvm. Output is being written to: /private/tmp/x/tasks/b8lp59xvm.output"}]},
 "toolUseResult":{"stdout":"","stderr":"","interrupted":false,"backgroundTaskId":"b8lp59xvm"}}
"""#)

private let agentLaunch = line(#"""
{"type":"user","uuid":"u2","timestamp":"2026-10-16T11:41:54.162Z",
 "message":{"role":"user","content":[{"tool_use_id":"toolu_01B","type":"tool_result","content":[{"type":"text","text":"Async agent launched successfully."}]}]},
 "toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"a18b745cce0cd1370","description":"Research"}}
"""#)

private func notification(_ id: String, queued: Bool) -> [String: Any] {
    let body = "<task-notification>\n<task-id>\(id)</task-id>\n<tool-use-id>toolu_013</tool-use-id>\n<status>completed</status>\n<summary>Background command \"Upload\" completed (exit code 0)</summary>\n</task-notification>"
    if queued {
        return ["type": "queue-operation", "operation": "enqueue",
                "timestamp": "2026-10-16T12:00:40.012Z", "content": body]
    }
    return ["type": "user", "uuid": "n-\(id)", "timestamp": "2026-10-16T12:00:40.100Z",
            "message": ["role": "user", "content": body]]
}

@Suite struct ParsingTests {
    @Test func backgroundLaunches() {
        #expect(ExecutorWatch.backgroundLaunch(bgLaunch)?.id == "b8lp59xvm")
        #expect(ExecutorWatch.backgroundLaunch(bgLaunch)?.isAgent == false)
        #expect(ExecutorWatch.backgroundLaunch(agentLaunch)?.id == "a18b745cce0cd1370")
        #expect(ExecutorWatch.backgroundLaunch(agentLaunch)?.isAgent == true)
        #expect(ExecutorWatch.backgroundLaunch(["type": "user", "toolUseResult": ["stdout": "hi"]]) == nil)
    }

    @Test func notificationIds() {
        let text = (notification("b8lp59xvm", queued: true)["content"] as! String)
        #expect(ExecutorWatch.notifiedTaskIds(text) == ["b8lp59xvm"])
        #expect(ExecutorWatch.notifiedTaskIds("<task-id>x</task-id>") == [])   // not a notification
        let two = "<task-notification><task-id>a</task-id></task-notification><task-notification><task-id>b</task-id></task-notification>"
        #expect(ExecutorWatch.notifiedTaskIds(two) == ["a", "b"])
    }

    @Test func toolResultsAreNotNotifications() {
        let msg: [String: Any] = ["content": [["type": "tool_result",
                                               "content": "<task-notification><task-id>b8lp59xvm</task-id>"]]]
        #expect(ExecutorWatch.userTexts(msg).isEmpty)
        #expect(ExecutorWatch.userTexts(["content": [["type": "text", "text": "hi"]]]) == ["hi"])
    }

    @Test func sleepError() {
        let err = assistant("e1", stop: "stop_sequence",
                            text: "API Error: Your computer went to sleep mid-response. The response above may be incomplete.",
                            apiError: true)
        #expect(ExecutorWatch.isSleepError(err))
        #expect(!ExecutorWatch.isSleepError(assistant("a1", stop: "end_turn", text: "went to sleep")))
    }

    @Test func stopTools() {
        #expect(ExecutorWatch.stoppedTaskIds(["type": "tool_use", "name": "TaskStop", "input": ["task_id": "b1"]]) == ["b1"])
        #expect(ExecutorWatch.stoppedTaskIds(["type": "tool_use", "name": "Bash", "input": ["command": "x"]]).isEmpty)
    }

    @Test func reportChange() {
        let t0 = Date(timeIntervalSince1970: 1000)
        #expect(ExecutorWatch.reportChange(now: nil, baseline: nil, sinceTell: false) == "no report file yet")
        #expect(ExecutorWatch.reportChange(now: t0, baseline: nil, sinceTell: false) == "report updated since dispatch")
        #expect(ExecutorWatch.reportChange(now: t0, baseline: t0, sinceTell: true) == "report NOT changed since your last tell")
        #expect(ExecutorWatch.reportChange(now: t0.addingTimeInterval(5), baseline: t0, sinceTell: true) == "report updated since your last tell")
    }

    @Test func doneNotes() {
        let log: [[String: Any]] = [["at": "2026-10-16T12:51:41Z", "text": "DONE"],
                                    ["at": "2026-10-16T13:00:00Z", "text": "Reviewed: fine"]]
        #expect(ExecutorWatch.doneNoted(log: log, since: MiaManager.date("2026-10-16T12:00:00Z")!))
        #expect(!ExecutorWatch.doneNoted(log: log, since: MiaManager.date("2026-10-16T12:52:00Z")!))
    }
}

/// The transcript lines drive AgentRun through AgentManager's real parser.
@Suite struct RunTrackingTests {
    let manager = AgentManager(autostart: false)

    func feed(_ run: AgentRun, _ lines: [[String: Any]]) {
        for l in lines { manager.handleEvent(l, run: run) }
    }

    func inputs(_ run: AgentRun, quiet: TimeInterval = 60) -> ExecutorWatch.Inputs {
        var i = ExecutorWatch.Inputs()
        i.sessionId = run.sessionId
        i.turnEnded = run.turnEnded
        i.turnClosed = run.turnClosed
        i.turnKey = run.turnEndKey
        i.sleepErrorKey = run.sleepErrorKey
        i.pendingShells = run.pendingBackground.values.filter { !$0.isAgent }.count
        i.pendingAgents = run.pendingBackground.values.filter { $0.isAgent }.count
        i.quiet = quiet
        return i
    }

    @Test func backgroundCommandIsNotAFinish() {
        let run = AgentRun(sessionId: "s", transcriptPath: "/dev/null")
        feed(run, [bgLaunch, assistant("t1", stop: "end_turn", text: "Uploading in the background."), closed])
        #expect(run.turnEnded)
        #expect(ExecutorWatch.verdict(inputs(run)) == .working)

        // The notification is queued while idle, then wakes the session. The
        // queue-operation alone must not make the turn-end read as a finish.
        feed(run, [notification("b8lp59xvm", queued: true)])
        #expect(ExecutorWatch.verdict(inputs(run)) == .working)
        feed(run, [notification("b8lp59xvm", queued: false)])
        #expect(run.pendingBackground.isEmpty)
        #expect(!run.turnEnded)
        #expect(ExecutorWatch.verdict(inputs(run)) == .working)
        feed(run, [assistant("t2", stop: "end_turn", text: "All uploaded."), closed])
        #expect(ExecutorWatch.verdict(inputs(run)) == .finished(key: "turn:t2", note: nil))
    }

    @Test func notificationMidTurnArrivesAsAttachment() {
        let run = AgentRun(sessionId: "s", transcriptPath: "/dev/null")
        let body = notification("b8lp59xvm", queued: true)["content"] as! String
        feed(run, [bgLaunch, assistant("t1", stop: "tool_use"),
                   ["type": "attachment", "attachment": ["type": "queued_command", "prompt": body]],
                   assistant("t2", stop: "end_turn"), closed])
        #expect(run.pendingBackground.isEmpty)
        #expect(ExecutorWatch.verdict(inputs(run)) == .finished(key: "turn:t2", note: nil))
    }

    @Test func oneMessageManyLinesIsOneFinish() {
        let run = AgentRun(sessionId: "s", transcriptPath: "/dev/null")
        var thinking = assistant("l1", stop: "end_turn", text: "")
        var text = assistant("l2", stop: "end_turn", text: "Done.")
        for i in [0, 1] {
            var o = i == 0 ? thinking : text
            var m = o["message"] as! [String: Any]
            m["id"] = "msg_1"
            o["message"] = m
            if i == 0 { thinking = o } else { text = o }
        }
        feed(run, [thinking])
        #expect(ExecutorWatch.verdict(inputs(run)) == .working)   // not closed yet
        feed(run, [text, closed])
        let first = ExecutorWatch.verdict(inputs(run))
        feed(run, [["type": "system", "subtype": "stop_hook_summary"]])
        #expect(first == ExecutorWatch.verdict(inputs(run)))
        #expect(first == .finished(key: "turn:msg_1", note: nil))
    }

    @Test func backgroundAgentIsNotAFinish() {
        let run = AgentRun(sessionId: "s", transcriptPath: "/dev/null")
        feed(run, [agentLaunch, assistant("t1", stop: "end_turn"), closed])
        #expect(ExecutorWatch.verdict(inputs(run)) == .working)
        feed(run, [notification("a18b745cce0cd1370", queued: false), assistant("t2", stop: "end_turn"), closed])
        #expect(ExecutorWatch.verdict(inputs(run)) == .finished(key: "turn:t2", note: nil))
    }

    /// 0238 at 00:28: the text block was written with end_turn, then the Mac
    /// slept mid-stream; no turn marker came until the sleep error.
    @Test func cutOffMessageIsNotAFinish() {
        let run = AgentRun(sessionId: "s", transcriptPath: "/dev/null")
        feed(run, [assistant("p1", stop: "end_turn", text: "The Buhl hook was missing for a reason")])
        var i = inputs(run, quiet: 7 * 60)                  // the Mac slept 7 min…
        i.quietAwake = 5                                    // …and woke 5 s ago
        #expect(ExecutorWatch.verdict(i) == .working)
        i.quietAwake = ExecutorWatch.unclosedGrace + 1      // no marker ever: trust it eventually
        #expect(ExecutorWatch.verdict(i) == .finished(key: "turn:p1", note: nil))
        feed(run, [assistant("e1", stop: "stop_sequence",
                             text: "API Error: Your computer went to sleep mid-response.", apiError: true), closed])
        #expect(ExecutorWatch.verdict(inputs(run, quiet: 30)) == .sleepStall(key: "sleep:e1"))
    }

    @Test func sleepErrorIsAStallAfterTheGrace() {
        let run = AgentRun(sessionId: "s", transcriptPath: "/dev/null")
        feed(run, [assistant("e1", stop: "stop_sequence",
                             text: "API Error: Your computer went to sleep mid-response.", apiError: true), closed])
        #expect(ExecutorWatch.verdict(inputs(run, quiet: 3)) == .working)
        #expect(ExecutorWatch.verdict(inputs(run, quiet: 30)) == .sleepStall(key: "sleep:e1"))
        // The resume lands: work again, and the error is forgotten.
        feed(run, [["type": "user", "uuid": "r", "message": ["role": "user", "content": "resume"]],
                   assistant("t9", stop: "end_turn"), closed])
        #expect(run.sleepErrorKey == nil)
        #expect(ExecutorWatch.verdict(inputs(run)) == .finished(key: "turn:t9", note: nil))
    }
}

@Suite struct VerdictTests {
    var base: ExecutorWatch.Inputs {
        var i = ExecutorWatch.Inputs()
        i.sessionId = "s"
        i.turnEnded = true
        i.turnClosed = true
        i.turnKey = "t1"
        i.quiet = 60
        return i
    }

    @Test func midTurnIsWorking() {
        var i = base
        i.turnEnded = false
        #expect(ExecutorWatch.verdict(i) == .working)
    }

    @Test func deadShellChildMeansFinished() {
        var i = base
        i.pendingShells = 1
        #expect(ExecutorWatch.verdict(i) == .working)          // unknown: trust the transcript
        i.shellChildAlive = true
        #expect(ExecutorWatch.verdict(i) == .working)
        i.shellChildAlive = false
        #expect(ExecutorWatch.verdict(i) == .finished(key: "turn:t1", note: nil))
    }

    @Test func doneNoteBeatsALeftoverDevServer() {
        var i = base
        i.pendingShells = 1
        i.shellChildAlive = true
        i.doneNoted = true
        #expect(ExecutorWatch.verdict(i) == .finished(key: "turn:t1", note: nil))
    }

    @Test func subagentStillWriting() {
        var i = base
        i.subagentsWorking = true
        #expect(ExecutorWatch.verdict(i) == .working)
    }

    @Test func staleBackgroundEventuallyReports() {
        var i = base
        i.pendingAgents = 1
        i.quiet = ExecutorWatch.staleBackground + 60
        guard case .finished(_, let note?) = ExecutorWatch.verdict(i) else {
            Issue.record("expected a finish with a note"); return
        }
        #expect(note.contains("background agent"))
    }

    @Test func exitAfterAFinishIsTheSameFinish() {
        var i = base
        i.exited = true
        #expect(ExecutorWatch.verdict(i) == .finished(key: "turn:t1", note: nil))
        i.turnEnded = false
        #expect(ExecutorWatch.verdict(i) == .exited(key: "exit:s"))
    }
}

@Suite struct KeepAwakeTests {
    @Test func holdsAndReleases() {
        var launched: [[String]] = []
        let k = KeepAwake()
        k.launcher = { args in
            launched.append(args)
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/sleep")
            p.arguments = ["30"]
            try? p.run()
            return p
        }
        k.sync(["a": 4242, "b": 0])
        #expect(k.sessions == ["a", "b"])
        #expect(launched.contains(["-i", "-s", "-w", "4242"]))
        #expect(launched.contains(["-i", "-s", "-t", "300"]))
        k.sync(["a": 4242])                       // b finished
        #expect(k.sessions == ["a"])
        #expect(launched.count == 2)              // a is not re-launched
        k.releaseAll()
        #expect(k.sessions.isEmpty)
    }
}

/// Replays the real transcripts that produced the false events, when they are
/// on this Mac: task 0238 (×6 "finished") and 0239 (finished 30 s after
/// dispatch). Counts the finishes the new rule would report.
@Suite struct ReplayTests {
    static let projects = NSHomeDirectory() + "/.claude/projects"

    func replay(_ path: String) -> [String]? {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        let manager = AgentManager(autostart: false)
        let run = AgentRun(sessionId: "replay", transcriptPath: path)
        let lines = text.split(separator: "\n").compactMap {
            try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
        }
        var reported: [String] = []
        var last: String?
        for (n, l) in lines.enumerated() {
            manager.handleEvent(l, run: run)
            // Quiet = the gap to the next line (how long the state held).
            // Judge only at timestamped lines (blobs and metadata carry none).
            guard let at = MiaManager.date(l["timestamp"]) else { continue }
            let next = lines[(n + 1)...].lazy.compactMap { MiaManager.date($0["timestamp"]) }.first
            var i = ExecutorWatch.Inputs()
            i.sessionId = "replay"
            i.turnEnded = run.turnEnded
            i.turnClosed = run.turnClosed     // quietAwake stays 0: markers only
            i.turnKey = run.turnEndKey
            i.sleepErrorKey = run.sleepErrorKey
            i.pendingShells = run.pendingBackground.values.filter { !$0.isAgent }.count
            i.pendingAgents = run.pendingBackground.values.filter { $0.isAgent }.count
            i.quiet = next.map { $0.timeIntervalSince(at) } ?? 3600
            switch ExecutorWatch.verdict(i) {
            case .finished(let k, _), .sleepStall(let k), .exited(let k):
                if k != last { reported.append(k); last = k }
            case .working: break
            }
        }
        return reported
    }

    @Test func task0239() throws {
        let p = Self.projects + "/-Users-danielmoen-PropIQ-0224/99a13d98-0d87-4ff3-8af5-ca7f293014aa.jsonl"
        guard let r = replay(p) else { return }
        print("0239 replay:", r)
        // The 23:31 turn-end (crawl running in the background) is not among them.
        #expect(!r.isEmpty)
    }

    @Test func task0238() throws {
        let p = Self.projects + "/-Users-danielmoen-bodycam-pipeline/d7b0e8ac-9308-4162-b342-6be015f52030.jsonl"
        guard let r = replay(p) else { return }
        print("0238 replay:", r.count, r)
        // The old rule reported 10 finishes; the 11:41 / 12:01 / 12:48 turn-ends
        // (uploads running in the background) and the three messages cut off
        // by sleep are gone, and the sleep errors are stalls to resume. (The
        // 11:32 one isn't: a task-notification restarted the turn 3 s later.)
        #expect(r.filter { $0.hasPrefix("sleep:") }.count == 3)
        #expect(r.filter { $0.hasPrefix("turn:") }.count == 3)
    }
}
