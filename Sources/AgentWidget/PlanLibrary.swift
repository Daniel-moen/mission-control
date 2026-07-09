import Foundation

/// The plan library: plans agents propose via ExitPlanMode, and plans the user
/// writes from the remote panel, saved as plain markdown files under
/// `~/.mission-control/plans/`. The files are the source of truth — this class
/// only reads and writes them — so plans survive relaunches and can be viewed,
/// edited, or committed with any tool.
///
/// File format: an optional YAML-ish frontmatter block Mission Control manages
/// (project dir, source session, created), then the plan body verbatim. The
/// panel only ever sees/edits the body; frontmatter survives saves untouched.
final class PlanLibrary {
    static let shared = PlanLibrary()

    struct PlanMeta {
        var id: String        // filename, e.g. "dark-mode--3fa9c2d1.md"
        var title: String     // first heading (or line) of the body
        var dir: String       // project dir the plan targets ("" = unset)
        var session: String   // source session id ("" = written by hand)
        var createdAt: Date
        var updatedAt: Date
        var preview: String   // first ~180 chars of body after the title
    }

    let root = NSHomeDirectory() + "/.mission-control/plans"
    private let fm = FileManager.default

    /// Directory listing + per-file header reads are cheap but not free — the
    /// snapshot asks every second, so serve a briefly cached list. Writes that
    /// go through this class invalidate it immediately.
    private var cache: [PlanMeta]?
    private var cacheAt = Date.distantPast

    // MARK: Listing

    func list() -> [PlanMeta] {
        if let cache, Date().timeIntervalSince(cacheAt) < 3 { return cache }
        var out: [PlanMeta] = []
        if let files = try? fm.contentsOfDirectory(atPath: root) {
            for f in files where f.hasSuffix(".md") && !f.hasPrefix(".") {
                guard let meta = readMeta(id: f) else { continue }
                out.append(meta)
            }
        }
        out.sort { $0.updatedAt > $1.updatedAt }
        cache = out
        cacheAt = Date()
        return out
    }

    private func invalidate() { cache = nil }

    // MARK: Reading

    /// The plan body (markdown, frontmatter stripped). nil if the id is bogus
    /// or the file is gone.
    func body(of id: String) -> String? {
        guard let raw = rawFile(id: id) else { return nil }
        return split(raw).body
    }

    func meta(of id: String) -> PlanMeta? { readMeta(id: id) }

    func path(of id: String) -> String { "\(root)/\(id)" }

    // MARK: Writing

    /// Replace a plan's body, keeping its frontmatter. Returns whether it wrote.
    @discardableResult
    func save(id: String, body newBody: String) -> Bool {
        guard validId(id), let raw = rawFile(id: id) else { return false }
        let front = split(raw).front
        let ok = write(front: front, body: newBody, to: path(of: id))
        if ok { invalidate() }
        return ok
    }

    /// Create a fresh plan file. Returns its id.
    @discardableResult
    func create(title: String, dir: String, body: String, session: String = "") -> String? {
        ensureRoot()
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        let content = text.isEmpty ? "# \(title.isEmpty ? "Untitled plan" : title)\n\n" : text
        var id = uniqueId(slug: slug(title.isEmpty ? Self.title(ofBody: content) : title))
        // Session-sourced plans encode the session in the name so revisions from
        // the same session overwrite instead of piling up (see capture()).
        if !session.isEmpty { id = uniqueId(slug: slug(title), sid: session) }
        let front = frontmatter(dir: dir, session: session, created: Date())
        guard write(front: front, body: content, to: path(of: id)) else { return nil }
        invalidate()
        return id
    }

    @discardableResult
    func delete(id: String) -> Bool {
        guard validId(id), fm.fileExists(atPath: path(of: id)) else { return false }
        let ok = (try? fm.removeItem(atPath: path(of: id))) != nil
        if ok { invalidate() }
        return ok
    }

    /// Auto-capture from a live agent's ExitPlanMode: the first plan from a
    /// session creates its file, revisions overwrite it (same file, fresh body),
    /// so the library holds each session's LATEST plan.
    func capture(_ text: String, session: String, dir: String, fallbackTitle: String) {
        ensureRoot()
        let sid8 = String(session.replacingOccurrences(of: "-", with: "").prefix(8))
        // An existing file from this session — regardless of its slug — is the
        // one to update.
        if let files = try? fm.contentsOfDirectory(atPath: root),
           let existing = files.first(where: { $0.hasSuffix("--\(sid8).md") }) {
            let front = split(rawFile(id: existing) ?? "").front
            _ = write(front: front.isEmpty ? frontmatter(dir: dir, session: session, created: Date()) : front,
                      body: text, to: path(of: existing))
            invalidate()
            return
        }
        let t = Self.title(ofBody: text)
        _ = create(title: t.isEmpty ? fallbackTitle : t, dir: dir, body: text, session: session)
    }

    // MARK: Internals

    private func ensureRoot() {
        try? fm.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    /// Filenames arrive over the wire — never let one escape the plans folder.
    private func validId(_ id: String) -> Bool {
        !id.isEmpty && id.hasSuffix(".md") && !id.hasPrefix(".")
            && !id.contains("/") && !id.contains("\\") && !id.contains("..")
    }

    private func rawFile(id: String) -> String? {
        guard validId(id) else { return nil }
        return try? String(contentsOfFile: path(of: id), encoding: .utf8)
    }

    private func readMeta(id: String) -> PlanMeta? {
        guard let raw = rawFile(id: id),
              let attrs = try? fm.attributesOfItem(atPath: path(of: id)) else { return nil }
        let (front, body) = split(raw)
        var dir = "", session = ""
        var created = (attrs[.creationDate] as? Date) ?? Date()
        for line in front.components(separatedBy: "\n") {
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }
            let key = parts[0].trimmingCharacters(in: .whitespaces)
            let val = parts[1].trimmingCharacters(in: .whitespaces)
            switch key {
            case "dir": dir = val
            case "session": session = val
            case "created":
                if let d = ISO8601DateFormatter().date(from: val) { created = d }
            default: break
            }
        }
        let title = Self.title(ofBody: body)
        return PlanMeta(
            id: id,
            title: title.isEmpty ? (id as NSString).deletingPathExtension : title,
            dir: dir, session: session, createdAt: created,
            updatedAt: (attrs[.modificationDate] as? Date) ?? created,
            preview: Self.preview(ofBody: body))
    }

    /// (frontmatter block including delimiters or "", body without it)
    private func split(_ raw: String) -> (front: String, body: String) {
        guard raw.hasPrefix("---\n") else { return ("", raw) }
        let rest = raw.dropFirst(4)
        guard let end = rest.range(of: "\n---\n") else { return ("", raw) }
        let front = String(rest[..<end.lowerBound])
        let body = String(rest[end.upperBound...])
        return (front, body)
    }

    private func frontmatter(dir: String, session: String, created: Date) -> String {
        var lines: [String] = []
        if !dir.isEmpty { lines.append("dir: \(dir)") }
        if !session.isEmpty { lines.append("session: \(session)") }
        lines.append("created: \(ISO8601DateFormatter().string(from: created))")
        return lines.joined(separator: "\n")
    }

    private func write(front: String, body: String, to path: String) -> Bool {
        ensureRoot()
        var text = ""
        if !front.isEmpty { text = "---\n\(front)\n---\n" }
        var b = body
        if !b.hasSuffix("\n") { b += "\n" }
        text += b
        return (try? text.write(toFile: path, atomically: true, encoding: .utf8)) != nil
    }

    private func slug(_ s: String) -> String {
        let lowered = s.lowercased()
        var out = ""
        for ch in lowered {
            if ch.isLetter || ch.isNumber { out.append(ch) }
            else if ch == " " || ch == "-" || ch == "_" {
                if !out.hasSuffix("-") { out.append("-") }
            }
            if out.count >= 40 { break }
        }
        while out.hasSuffix("-") { out.removeLast() }
        return out.isEmpty ? "plan" : out
    }

    private func uniqueId(slug: String, sid: String = "") -> String {
        if !sid.isEmpty {
            let sid8 = String(sid.replacingOccurrences(of: "-", with: "").prefix(8))
            return "\(slug)--\(sid8).md"
        }
        var id = "\(slug).md"
        var n = 2
        while fm.fileExists(atPath: path(of: id)) {
            id = "\(slug)-\(n).md"
            n += 1
        }
        return id
    }

    /// First markdown heading in the body (else its first non-empty line).
    static func title(ofBody body: String) -> String {
        var fallback = ""
        for line in body.components(separatedBy: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { continue }
            if t.hasPrefix("#") {
                let stripped = t.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces)
                if !stripped.isEmpty { return String(stripped.prefix(90)) }
            }
            if fallback.isEmpty { fallback = String(t.prefix(90)) }
        }
        return fallback
    }

    /// A couple of plain-text lines after the title, for the plan card.
    static func preview(ofBody body: String) -> String {
        var sawTitle = false
        var out: [String] = []
        for line in body.components(separatedBy: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { continue }
            if !sawTitle { sawTitle = true; if t.hasPrefix("#") { continue } }
            out.append(t)
            if out.joined(separator: " ").count > 180 { break }
        }
        return String(out.joined(separator: " ").prefix(180))
    }
}
