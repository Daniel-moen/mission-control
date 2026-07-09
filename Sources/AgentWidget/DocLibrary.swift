import Foundation

/// The document library: the one central directory for everything the fleet
/// thinks, plans, and finds out. Plain markdown files under
/// `~/.mission-control/library/` — plans agents propose via ExitPlanMode,
/// research reports agents write, and notes you write yourself.
///
/// The files are the source of truth. This class only reads and writes them, so
/// a doc survives relaunches and can be opened, edited, grepped, or committed
/// with any tool — including by an agent that never heard of Mission Control.
///
/// File format: a YAML-ish frontmatter block Mission Control manages, then the
/// markdown body verbatim.
///
///     ---
///     kind: research
///     status: done
///     subject: Acme Corp
///     tags: pricing, competitors
///     dir: /Users/me/work/acme
///     session: 3fa9c2d1-…
///     created: 2026-07-09T18:22:04Z
///     ---
///     # Acme Corp — pricing teardown
///     …
///
/// Only the body is ever shown or edited as "the document"; frontmatter is
/// metadata and survives body saves untouched.
final class DocLibrary {
    static let shared = DocLibrary()

    // MARK: Vocabulary

    /// What a document *is*. Drives its icon, its filters, and what an agent is
    /// told to do when you dispatch it.
    enum Kind: String, CaseIterable {
        case plan       // an implementation plan — something to build
        case research   // findings about a topic, company, technology
        case note       // anything else you want to keep

        /// Unknown/garbage values on disk degrade to `.note` rather than
        /// dropping the file out of the library.
        init(loose: String) {
            self = Kind(rawValue: loose.lowercased()) ?? .note
        }

        var label: String {
            switch self {
            case .plan: return "Plan"
            case .research: return "Research"
            case .note: return "Note"
            }
        }
    }

    /// Where a document is in its life. `active` means an agent is working on
    /// it right now (a research agent sets it while it writes).
    enum Status: String, CaseIterable {
        case draft
        case active
        case done
        case archived

        init(loose: String) {
            self = Status(rawValue: loose.lowercased()) ?? .draft
        }
    }

    struct DocMeta {
        var id: String          // filename, e.g. "acme-pricing--3fa9c2d1.md"
        var title: String       // first heading (or line) of the body
        var kind: Kind
        var status: Status
        var subject: String     // the company/product/thing it's about ("" = none)
        var tags: [String]
        var dir: String         // project dir it relates to ("" = unset)
        var session: String     // source session id ("" = written by hand)
        var createdAt: Date
        var updatedAt: Date
        var preview: String     // first ~180 chars of body after the title
        var words: Int
    }

    /// `MC_LIBRARY` relocates the library. The `mc-doc` CLI reads the same
    /// variable, so the app and the agents' tooling never disagree about where
    /// the documents live.
    let root = ProcessInfo.processInfo.environment["MC_LIBRARY"]
        ?? NSHomeDirectory() + "/.mission-control/library"
    /// Where plans lived before the library existed — the `plans` sibling of
    /// whatever `root` resolved to. Migrated on first use.
    private lazy var legacyRoot = (root as NSString).deletingLastPathComponent + "/plans"
    private let fm = FileManager.default

    /// Directory listing + per-file reads are cheap but not free — the snapshot
    /// asks every second, so serve a briefly cached list. Writes that go through
    /// this class invalidate it immediately. An agent writing a file directly
    /// (via `mc-doc`, or just the Write tool) shows up within the TTL.
    private var cache: [DocMeta]?
    private var cacheAt = Date.distantPast

    private init() {
        migrateLegacyPlansIfNeeded()
    }

    // MARK: Listing

    func list() -> [DocMeta] {
        if let cache, Date().timeIntervalSince(cacheAt) < 2 { return cache }
        var out: [DocMeta] = []
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

    /// The document body (markdown, frontmatter stripped). nil if the id is
    /// bogus or the file is gone.
    func body(of id: String) -> String? {
        guard let raw = rawFile(id: id) else { return nil }
        return split(raw).body
    }

    func meta(of id: String) -> DocMeta? { readMeta(id: id) }

    func path(of id: String) -> String { "\(root)/\(id)" }

    /// Case-insensitive full-text search across every body. Returns at most
    /// `limit` documents, each with the first few matching lines. Bodies are
    /// small markdown files and this only runs on an explicit search, so a plain
    /// linear scan is the right amount of machinery.
    func search(_ query: String, limit: Int = 40) -> [(meta: DocMeta, snippets: [String])] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return [] }
        var hits: [(DocMeta, [String])] = []
        for meta in list() {
            guard let body = body(of: meta.id) else { continue }
            var snippets: [String] = []
            // A title/subject/tag match counts even when the body never says it.
            let metaHay = "\(meta.title) \(meta.subject) \(meta.tags.joined(separator: " "))".lowercased()
            for line in body.components(separatedBy: "\n") {
                guard line.lowercased().contains(q) else { continue }
                let t = line.trimmingCharacters(in: .whitespaces)
                if t.isEmpty { continue }
                snippets.append(String(t.prefix(220)))
                if snippets.count >= 3 { break }
            }
            if snippets.isEmpty && !metaHay.contains(q) { continue }
            hits.append((meta, snippets))
            if hits.count >= limit { break }
        }
        return hits
    }

    // MARK: Writing

    /// Replace a document's body, keeping its frontmatter. Returns whether it wrote.
    @discardableResult
    func save(id: String, body newBody: String) -> Bool {
        guard validId(id), let raw = rawFile(id: id) else { return false }
        let front = split(raw).front
        let ok = write(front: front, body: newBody, to: path(of: id))
        if ok { invalidate() }
        return ok
    }

    /// Change metadata without touching the body. Every parameter is optional —
    /// nil means "leave it alone".
    @discardableResult
    func update(id: String, kind: Kind? = nil, status: Status? = nil,
                subject: String? = nil, tags: [String]? = nil, dir: String? = nil) -> Bool {
        guard validId(id), let raw = rawFile(id: id), let cur = readMeta(id: id) else { return false }
        let front = frontmatter(
            kind: kind ?? cur.kind,
            status: status ?? cur.status,
            subject: subject ?? cur.subject,
            tags: tags ?? cur.tags,
            dir: dir ?? cur.dir,
            session: cur.session,
            created: cur.createdAt)
        let ok = write(front: front, body: split(raw).body, to: path(of: id))
        if ok { invalidate() }
        return ok
    }

    /// Create a fresh document. Returns its id.
    @discardableResult
    func create(title: String, kind: Kind = .note, status: Status = .draft,
                subject: String = "", tags: [String] = [], dir: String = "",
                body: String = "", session: String = "") -> String? {
        ensureRoot()
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        let heading = title.isEmpty ? "Untitled \(kind.label.lowercased())" : title
        let content = text.isEmpty ? "# \(heading)\n\n" : text
        // Session-sourced docs encode the session in the name so revisions from
        // the same session overwrite instead of piling up (see capture()).
        let slugSource = title.isEmpty ? Self.title(ofBody: content) : title
        let id = session.isEmpty
            ? uniqueId(slug: slug(slugSource))
            : uniqueId(slug: slug(slugSource), sid: session)
        let front = frontmatter(kind: kind, status: status, subject: subject,
                                tags: tags, dir: dir, session: session, created: Date())
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
        let sid8 = Self.shortSession(session)
        // An existing file from this session — regardless of its slug — is the
        // one to update. Keep whatever kind/status/tags it has grown since.
        if let files = try? fm.contentsOfDirectory(atPath: root),
           let existing = files.first(where: { $0.hasSuffix("--\(sid8).md") }) {
            let front = split(rawFile(id: existing) ?? "").front
            let resolved = front.isEmpty
                ? frontmatter(kind: .plan, status: .draft, subject: "", tags: [],
                              dir: dir, session: session, created: Date())
                : front
            _ = write(front: resolved, body: text, to: path(of: existing))
            invalidate()
            return
        }
        let t = Self.title(ofBody: text)
        _ = create(title: t.isEmpty ? fallbackTitle : t, kind: .plan, status: .draft,
                   dir: dir, body: text, session: session)
    }

    // MARK: Internals

    private func ensureRoot() {
        try? fm.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    /// One-time move of `~/.mission-control/plans/*.md` into the library, tagging
    /// each as `kind: plan`. Non-destructive: files that fail to move are left
    /// where they are, and an existing library file of the same name always wins.
    private func migrateLegacyPlansIfNeeded() {
        guard fm.fileExists(atPath: legacyRoot),
              let files = try? fm.contentsOfDirectory(atPath: legacyRoot),
              files.contains(where: { $0.hasSuffix(".md") }) else { return }
        ensureRoot()
        for f in files where f.hasSuffix(".md") && !f.hasPrefix(".") {
            let src = "\(legacyRoot)/\(f)"
            let dst = path(of: f)
            guard !fm.fileExists(atPath: dst) else { continue }
            guard let raw = try? String(contentsOfFile: src, encoding: .utf8) else { continue }
            let (front, body) = split(raw)
            // Re-emit the frontmatter through the current writer so the migrated
            // file gains `kind:`/`status:` and reads like a native doc.
            let parsed = parseFront(front)
            let created = parsed["created"].flatMap { ISO8601DateFormatter().date(from: $0) }
                ?? (try? fm.attributesOfItem(atPath: src))?[.creationDate] as? Date
                ?? Date()
            let newFront = frontmatter(
                kind: .plan, status: .draft, subject: "", tags: [],
                dir: parsed["dir"] ?? "", session: parsed["session"] ?? "", created: created)
            guard write(front: newFront, body: body, to: dst) else { continue }
            try? fm.removeItem(atPath: src)
        }
        // Leave an empty legacy folder behind rather than removing it — cheap,
        // and it makes the migration obviously reversible if something went wrong.
        invalidate()
    }

    /// Filenames arrive over the wire — never let one escape the library folder.
    private func validId(_ id: String) -> Bool {
        !id.isEmpty && id.hasSuffix(".md") && !id.hasPrefix(".")
            && !id.contains("/") && !id.contains("\\") && !id.contains("..")
    }

    private func rawFile(id: String) -> String? {
        guard validId(id) else { return nil }
        return try? String(contentsOfFile: path(of: id), encoding: .utf8)
    }

    private func readMeta(id: String) -> DocMeta? {
        guard let raw = rawFile(id: id),
              let attrs = try? fm.attributesOfItem(atPath: path(of: id)) else { return nil }
        let (front, body) = split(raw)
        let f = parseFront(front)
        let created = f["created"].flatMap { ISO8601DateFormatter().date(from: $0) }
            ?? (attrs[.creationDate] as? Date) ?? Date()
        let tags = (f["tags"] ?? "")
            .components(separatedBy: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let title = Self.title(ofBody: body)
        return DocMeta(
            id: id,
            title: title.isEmpty ? (id as NSString).deletingPathExtension : title,
            // A doc with no `kind:` that came from a session is a captured plan;
            // one you hand-wrote is a note. Keeps pre-library files sensible.
            kind: f["kind"].map(Kind.init(loose:)) ?? ((f["session"] ?? "").isEmpty ? .note : .plan),
            status: f["status"].map(Status.init(loose:)) ?? .draft,
            subject: f["subject"] ?? "",
            tags: tags,
            dir: f["dir"] ?? "",
            session: f["session"] ?? "",
            createdAt: created,
            updatedAt: (attrs[.modificationDate] as? Date) ?? created,
            preview: Self.preview(ofBody: body),
            words: body.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }).count)
    }

    /// (frontmatter block WITHOUT delimiters or "", body without it)
    private func split(_ raw: String) -> (front: String, body: String) {
        guard raw.hasPrefix("---\n") else { return ("", raw) }
        let rest = raw.dropFirst(4)
        guard let end = rest.range(of: "\n---\n") else { return ("", raw) }
        return (String(rest[..<end.lowerBound]), String(rest[end.upperBound...]))
    }

    private func parseFront(_ front: String) -> [String: String] {
        var out: [String: String] = [:]
        for line in front.components(separatedBy: "\n") {
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }
            let key = parts[0].trimmingCharacters(in: .whitespaces).lowercased()
            let val = parts[1].trimmingCharacters(in: .whitespaces)
            if !val.isEmpty { out[key] = val }
        }
        return out
    }

    private func frontmatter(kind: Kind, status: Status, subject: String, tags: [String],
                             dir: String, session: String, created: Date) -> String {
        var lines = ["kind: \(kind.rawValue)", "status: \(status.rawValue)"]
        // Values are written on one line each, so a stray newline would forge a
        // frontmatter key. Flatten them.
        let clean = { (s: String) in
            s.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        }
        let subj = clean(subject)
        if !subj.isEmpty { lines.append("subject: \(subj)") }
        let tg = tags.map(clean).filter { !$0.isEmpty && !$0.contains(",") }
        if !tg.isEmpty { lines.append("tags: \(tg.joined(separator: ", "))") }
        let d = clean(dir)
        if !d.isEmpty { lines.append("dir: \(d)") }
        if !session.isEmpty { lines.append("session: \(clean(session))") }
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
        var out = ""
        for ch in s.lowercased() {
            if ch.isLetter || ch.isNumber { out.append(ch) }
            else if ch == " " || ch == "-" || ch == "_" {
                if !out.hasSuffix("-") { out.append("-") }
            }
            if out.count >= 40 { break }
        }
        while out.hasSuffix("-") { out.removeLast() }
        return out.isEmpty ? "doc" : out
    }

    private func uniqueId(slug: String, sid: String = "") -> String {
        if !sid.isEmpty { return "\(slug)--\(Self.shortSession(sid)).md" }
        var id = "\(slug).md"
        var n = 2
        while fm.fileExists(atPath: path(of: id)) {
            id = "\(slug)-\(n).md"
            n += 1
        }
        return id
    }

    static func shortSession(_ session: String) -> String {
        String(session.replacingOccurrences(of: "-", with: "").prefix(8))
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

    /// A couple of plain-text lines after the title, for the document card.
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
