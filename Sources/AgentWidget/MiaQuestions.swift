import Foundation

/// Which of Mia's questions are still waiting on Daniel — pure rules shared by
/// MiaManager and its test harness (remote/test/mac/questions.swift), and kept
/// in step with the `mia` CLI (scripts/mia, `mia question …`).
///
/// A question is open until it's answered or closed. Closures live in
/// questions.json — {"maxAgeHours": 48, "closed": {qid: {state, at, by}}} —
/// where state is "dismissed" (Daniel, from the panel, or Mia) or "expired"
/// (`mia question expire`). Open questions older than maxAgeHours are "old":
/// hidden from badges, the home stack and read-aloud, but never deleted and
/// still answerable. maxAgeHours 0 means never hide.
enum MiaQuestions {
    static let defaultMaxAgeHours = 48.0

    struct State {
        var maxAgeHours = MiaQuestions.defaultMaxAgeHours
        var closed: [String: [String: Any]] = [:]

        init() {}

        init(json: Any?) {
            guard let o = json as? [String: Any] else { return }
            if let n = o["maxAgeHours"] as? NSNumber { maxAgeHours = max(0, n.doubleValue) }
            closed = (o["closed"] as? [String: [String: Any]]) ?? [:]
        }

        var json: [String: Any] {
            let h: Any = maxAgeHours == maxAgeHours.rounded() ? Int(maxAgeHours) : maxAgeHours
            return ["maxAgeHours": h, "closed": closed]
        }

        func state(of qid: String) -> String? { closed[qid]?["state"] as? String }
    }

    /// Unanswered, unclosed question messages, in thread order.
    static func open(_ msgs: [[String: Any]], _ st: State) -> [[String: Any]] {
        let answered = Set(msgs.compactMap { ($0["kind"] as? String) == "answer" ? $0["questionId"] as? String : nil })
        return msgs.filter { m in
            guard (m["kind"] as? String) == "question", let qid = m["questionId"] as? String else { return false }
            return !answered.contains(qid) && st.closed[qid] == nil
        }
    }

    static func ageHours(_ q: [String: Any], now: Date) -> Double {
        guard let at = date(q["at"]) else { return 0 }
        return now.timeIntervalSince(at) / 3600
    }

    static func isOld(_ q: [String: Any], maxAgeHours: Double, now: Date) -> Bool {
        maxAgeHours > 0 && ageHours(q, now: now) > maxAgeHours
    }

    /// Open questions split into the ones Daniel sees and the old, hidden ones.
    static func split(_ open: [[String: Any]], maxAgeHours: Double, now: Date)
        -> (fresh: [[String: Any]], old: [[String: Any]]) {
        var fresh: [[String: Any]] = [], old: [[String: Any]] = []
        for q in open {
            if isOld(q, maxAgeHours: maxAgeHours, now: now) { old.append(q) } else { fresh.append(q) }
        }
        return (fresh, old)
    }

    /// The `[MC]` line Mia gets when Daniel dismisses questions.
    static func dismissedLine(_ qs: [[String: Any]], old: Bool) -> String {
        func ref(_ q: [String: Any]) -> String {
            let id = q["questionId"] as? String ?? "?"
            return (q["taskId"] as? String).map { "\(id) (task \($0))" } ?? id
        }
        if qs.count == 1, let q = qs.first {
            let text = clip(q["text"] as? String ?? "", 120)
            return "[MC] Daniel dismissed \(ref(q)) — no answer is coming, don't wait on it: \"\(text)\""
        }
        let what = old ? "\(qs.count) old questions" : "\(qs.count) questions"
        return "[MC] Daniel dismissed \(what) — no answers are coming, don't wait on them: "
            + qs.map(ref).joined(separator: ", ")
    }

    static func clip(_ s: String, _ n: Int) -> String {
        let flat = s.split(whereSeparator: { $0.isNewline }).joined(separator: " ")
        return flat.count <= n ? flat : String(flat.prefix(n - 1)) + "…"
    }

    private static let isoOut: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func date(_ v: Any?) -> Date? {
        guard let s = v as? String, !s.isEmpty else { return nil }
        return isoOut.date(from: s)
    }
}
