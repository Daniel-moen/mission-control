// Unit checks for Sources/AgentWidget/MiaQuestions.swift — the rules the Mac
// app uses to decide which of Mia's questions are open, old or dismissed.
// Built and run by test/questions-test.mjs (swiftc, no Xcode project needed).
import Foundation

var failures = 0
func check(_ cond: Bool, _ label: String) {
    print(cond ? "  ✓ \(label)" : "  ✗ \(label)")
    if !cond { failures += 1 }
}

let now = ISO8601DateFormatter().date(from: "2026-10-06T12:00:00Z")!
func ago(_ h: Double) -> String { ISO8601DateFormatter().string(from: now.addingTimeInterval(-h * 3600)) }
func q(_ id: String, _ h: Double, task: String? = nil, text: String = "Which one?") -> [String: Any] {
    var m: [String: Any] = ["id": "m_\(id)", "kind": "question", "questionId": id, "text": text, "at": ago(h), "from": "mia"]
    if let task { m["taskId"] = task }
    return m
}

let msgs: [[String: Any]] = [
    q("q_1", 200, task: "0007"), q("q_2", 72), q("q_3", 47), q("q_4", 1),
    ["kind": "answer", "questionId": "q_2", "text": "Yes", "from": "daniel"],
    q("q_5", 100, text: "Line one\nline two"),
    ["kind": "chat", "text": "hi", "from": "mia"],
]

// Defaults and parsing
var st = MiaQuestions.State(json: nil)
check(st.maxAgeHours == 48 && st.closed.isEmpty, "no questions.json → 48 h, nothing closed")
st = MiaQuestions.State(json: ["maxAgeHours": 24, "closed": ["q_5": ["state": "expired", "at": "x", "by": "mia"]]])
check(st.maxAgeHours == 24 && st.state(of: "q_5") == "expired", "reads maxAgeHours and closures")
check(MiaQuestions.State(json: ["maxAgeHours": -3]).maxAgeHours == 0, "negative age clamps to 0 (never hide)")
check((MiaQuestions.State(json: ["maxAgeHours": 48]).json["maxAgeHours"] as? Int) == 48, "whole hours round-trip as an integer")

// Open = unanswered and not closed
st = MiaQuestions.State()
let open0 = MiaQuestions.open(msgs, st).map { $0["questionId"] as! String }
check(open0 == ["q_1", "q_3", "q_4", "q_5"], "answered questions are not open")
st.closed["q_5"] = ["state": "dismissed"]
let open1 = MiaQuestions.open(msgs, st)
check(open1.map { $0["questionId"] as! String } == ["q_1", "q_3", "q_4"], "dismissed questions are not open")

// Old vs fresh
let (fresh, old) = MiaQuestions.split(open1, maxAgeHours: 48, now: now)
check(fresh.map { $0["questionId"] as! String } == ["q_3", "q_4"], "47 h and 1 h old stay visible at 48 h")
check(old.map { $0["questionId"] as! String } == ["q_1"], "200 h old is hidden at 48 h")
let (fresh0, old0) = MiaQuestions.split(open1, maxAgeHours: 0, now: now)
check(fresh0.count == 3 && old0.isEmpty, "max age 0 never hides anything")
check(MiaQuestions.isOld(q("x", 25), maxAgeHours: 24, now: now) && !MiaQuestions.isOld(q("x", 23), maxAgeHours: 24, now: now),
      "a 24 h setting hides at 24 h, not before")
check(!MiaQuestions.isOld(["at": "garbage"], maxAgeHours: 1, now: now), "unparseable time is never old")

// The [MC] line Mia gets
let one = MiaQuestions.dismissedLine([q("q_9", 3, task: "0012", text: "Ship it?\nNow?")], old: false)
check(one == "[MC] Daniel dismissed q_9 (task 0012) — no answer is coming, don't wait on it: \"Ship it? Now?\"",
      "single dismissal names the id, task and text")
let many = MiaQuestions.dismissedLine([q("q_1", 200, task: "0007"), q("q_5", 100)], old: true)
check(many == "[MC] Daniel dismissed 2 old questions — no answers are coming, don't wait on them: q_1 (task 0007), q_5",
      "dismiss-all-old lists every id")
check(MiaQuestions.clip(String(repeating: "a", count: 300), 120).count == 120, "long question text is clipped")

exit(failures == 0 ? 0 : 1)
