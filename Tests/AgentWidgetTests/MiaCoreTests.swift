import Foundation
import Testing
@testable import AgentWidget

// The app's side of mia-core (task 0292): core.json switches, the inbox feed
// (each event once, across app restarts) and Mia's session resume helpers.

private func tempDir() -> String {
    let d = NSTemporaryDirectory() + "mia-core-link-\(UUID().uuidString)"
    try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    return d
}

@Test func configDefaultsAreAllOff() {
    let c = MiaCoreLink.Config.parse(nil)
    #expect(!c.wantsCore && !c.headless && !c.heartbeatRuns && !c.miaResume && !c.legacyCap && !c.reapLegacy)
    #expect(c.maxConcurrent == 4)
    #expect(MiaCoreLink.Config.parse(Data("not json".utf8)) == MiaCoreLink.Config())
}

@Test func configReadsSwitches() {
    let c = MiaCoreLink.Config.parse(Data(#"""
    {"headless":true,"maxConcurrent":2,"miaResume":true,"legacyCap":true,"reapLegacy":true,
     "heartbeats":{"enabled":true,"beats":{"hb_health":"health"}}}
    """#.utf8))
    #expect(c.headless && c.wantsCore && c.miaResume && c.legacyCap && c.reapLegacy)
    #expect(c.maxConcurrent == 2)
    #expect(c.heartbeatRuns && c.beats == ["hb_health"])
    let d = MiaCoreLink.Config.parse(Data(#"{"heartbeats":{"enabled":true}}"#.utf8))
    #expect(d.wantsCore && d.beats == MiaCoreLink.Config.defaultBeats)
}

@Test func inboxLinesArriveOnceAcrossRestarts() throws {
    let dir = tempDir()
    let inbox = dir + "/inbox.jsonl"
    let a = #"{"id":"c_1","kind":"executor","text":"[MC] Executor for task 0001 finished","taskId":"0001","mirror":"Executor for 0001 finished","deliver":true}"#
    let b = #"{"id":"c_2","kind":"stall","text":"[MC] resumed","deliver":false}"#
    try (a + "\n" + b + "\n" + #"{"id":"c_3","kind":"exec"# ).write(toFile: inbox, atomically: true, encoding: .utf8)

    let link = MiaCoreLink(dir: dir)
    var got: [MiaCoreLink.Event] = []
    link.newEvents { got += $0 }
    #expect(got.map(\.id) == ["c_1", "c_2"])        // the half-written third line waits
    #expect(got[0].taskId == "0001" && got[0].deliver && got[0].mirror == "Executor for 0001 finished")
    #expect(!got[1].deliver)

    // The same line repeated (a crash between append and mark) is dropped.
    let h = try #require(FileHandle(forWritingAtPath: inbox))
    h.seekToEndOfFile()
    h.write(Data((#"utor","text":"third","deliver":true}"# + "\n" + a + "\n").utf8))
    try h.close()
    got = []
    link.newEvents { got += $0 }
    #expect(got.map(\.id) == ["c_3"])

    // A new app instance resumes from the saved offset: nothing again.
    let again = MiaCoreLink(dir: dir)
    var none: [MiaCoreLink.Event] = []
    again.newEvents { none += $0 }
    #expect(none.isEmpty)
}

@Test func resumeHelpers() {
    let p = MiaCoreLink.transcriptPath(home: "/Users/d", cwd: "/Users/d/.mission-control/mia", sessionId: "abc")
    #expect(p == "/Users/d/.claude/projects/-Users-d--mission-control-mia/abc.jsonl")
    let note = MiaCoreLink.resumeNote(restarts: 3, downSince: nil)
    #expect(note.hasPrefix(MiaManager.miaPromptPrefix))     // still recognised as Mia
    #expect(note.contains("mia inbox") && note.contains("restart 3"))
}
