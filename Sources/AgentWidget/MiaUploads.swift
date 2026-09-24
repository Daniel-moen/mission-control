import Foundation
import CryptoKit

/// Files Daniel hands Mia from the panel (docs/mia.md §8.4).
///
/// The relay (remote/upload.js) validates an upload, keeps it in a private
/// temp file and offers it here as `{type:"upload", id, key, name, mime, size,
/// sha256, caption?, batch?, batchId?}`. This pulls the bytes over HTTPS
/// (`GET /upload/<id>`, the panel token plus the one-off key), checks size and
/// checksum, and saves it to `~/.mission-control/mia/uploads/<yyyy-MM-dd>/<name>`
/// with a safe, unique name. RemoteBridge then answers `uploadDone` so the
/// relay deletes its copy, and MiaManager puts the file in the thread and
/// tells Mia.
///
/// Foundation + CryptoKit only, so it can be compiled into a test harness on
/// its own (see remote/test/upload-mac-e2e.sh).
final class MiaUploads {
    struct Offer {
        let id: String
        let key: String
        let name: String
        let mime: String
        let size: Int
        let sha256: String
        let caption: String
        let batch: String
        let batchId: String
    }

    struct Saved {
        let offer: Offer
        let path: String
        /// True when this upload was already saved earlier (a re-offer after a
        /// lost uploadDone) — confirm it again, but don't tell Mia twice.
        let duplicate: Bool
    }

    /// The relay is the enforcer (UPLOAD_MAX_MB, default 50); this is only a
    /// sanity bound so a confused relay can't fill the disk.
    static let hardMaxBytes = 512 * 1024 * 1024

    /// Same list as remote/upload.js TYPES.
    static let allowedExtensions: Set<String> = [
        "pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff",
        "docx", "xlsx", "pptx", "doc", "xls", "ppt", "odt", "ods", "pages", "numbers", "key", "rtf",
        "txt", "md", "csv", "tsv", "json",
        "mp3", "m4a", "aac", "wav", "aif", "aiff", "caf", "flac", "ogg", "oga", "opus", "webm",
    ]

    let root: String
    var uploadsDir: String { root + "/uploads" }
    var indexPath: String { root + "/uploads.jsonl" }

    private let fm = FileManager.default
    private let session: URLSession
    private var inFlight: Set<String> = []
    /// relay upload id → saved path, for everything already on disk.
    private var saved: [String: String] = [:]

    init(root: String, session: URLSession = .shared) {
        self.root = root
        self.session = session
        // Remember what earlier runs saved, so a re-offer can't duplicate.
        if let text = try? String(contentsOfFile: root + "/uploads.jsonl", encoding: .utf8) {
            for line in text.split(separator: "\n") {
                guard let d = line.data(using: .utf8),
                      let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
                      let id = o["id"] as? String, let p = o["path"] as? String else { continue }
                saved[id] = p
            }
        }
    }

    static func offer(from obj: [String: Any]) -> Offer? {
        func s(_ k: String) -> String { (obj[k] as? String) ?? "" }
        let size = (obj["size"] as? NSNumber)?.intValue ?? -1
        guard !s("id").isEmpty, !s("key").isEmpty, !s("name").isEmpty, size >= 0 else { return nil }
        return Offer(id: s("id"), key: s("key"), name: s("name"), mime: s("mime"), size: size,
                     sha256: s("sha256").lowercased(), caption: s("caption"),
                     batch: s("batch"), batchId: s("batchId"))
    }

    /// Fetch, verify and save one offered upload. `relay` is the relay's
    /// http(s) origin. Completion runs on the main queue.
    func receive(_ o: Offer, relay: URL, token: String,
                 completion: @escaping (Result<Saved, UploadError>) -> Void) {
        let done: (Result<Saved, UploadError>) -> Void = { r in
            DispatchQueue.main.async {
                self.inFlight.remove(o.id)
                if case .success(let s) = r { self.saved[o.id] = s.path }
                completion(r)
            }
        }
        if let p = saved[o.id], fm.fileExists(atPath: p) {
            return completion(.success(Saved(offer: o, path: p, duplicate: true)))
        }
        guard !inFlight.contains(o.id) else { return }   // already fetching; that one answers
        let ext = (o.name as NSString).pathExtension.lowercased()
        guard Self.allowedExtensions.contains(ext) else {
            return completion(.failure(.init("the Mac doesn't accept .\(ext) files")))
        }
        guard o.size > 0, o.size <= Self.hardMaxBytes else {
            return completion(.failure(.init("bad size \(o.size)")))
        }
        inFlight.insert(o.id)

        var req = URLRequest(url: relay.appendingPathComponent("upload").appendingPathComponent(o.id))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(o.key, forHTTPHeaderField: "X-MC-Key")
        req.timeoutInterval = 120
        session.downloadTask(with: req) { [self] tmp, resp, err in
            // `tmp` is deleted when this closure returns — move it out first.
            if let err { return done(.failure(.init("download failed: \(err.localizedDescription)"))) }
            guard let http = resp as? HTTPURLResponse, http.statusCode == 200, let tmp else {
                return done(.failure(.init("relay answered \((resp as? HTTPURLResponse)?.statusCode ?? 0)")))
            }
            let size = ((try? fm.attributesOfItem(atPath: tmp.path))?[.size] as? NSNumber)?.intValue ?? -1
            guard size == o.size else { return done(.failure(.init("size mismatch (\(size) ≠ \(o.size))"))) }
            if !o.sha256.isEmpty, Self.sha256(of: tmp) != o.sha256 {
                return done(.failure(.init("checksum mismatch")))
            }
            do {
                let dir = uploadsDir + "/" + Self.dayStamp(Date())
                try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
                let dest = Self.uniquePath(dir: dir, name: Self.safeName(o.name), fm: fm)
                try fm.moveItem(at: tmp, to: URL(fileURLWithPath: dest))
                try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: dest)
                done(.success(Saved(offer: o, path: dest, duplicate: false)))
            } catch {
                done(.failure(.init("couldn't save: \(error.localizedDescription)")))
            }
        }.resume()
    }

    struct UploadError: Error { let detail: String; init(_ d: String) { detail = d } }

    // MARK: Names

    /// A file name that is safe on disk and in a shell-quoted path: no
    /// separators, control characters or leading dots; NFC; at most 150
    /// characters; the extension kept.
    static func safeName(_ raw: String) -> String {
        var n = raw.precomposedStringWithCanonicalMapping
        n = String(n.unicodeScalars.map { s -> Character in
            if s.value < 0x20 || s.value == 0x7f || s == "/" || s == "\\" || s == ":" { return " " }
            return Character(s)
        })
        n = n.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        while let c = n.first, c == "." || c.isWhitespace { n.removeFirst() }
        n = n.trimmingCharacters(in: .whitespaces)
        let ext = (n as NSString).pathExtension
        var stem = (n as NSString).deletingPathExtension
        if stem.count > 150 { stem = String(stem.prefix(150)).trimmingCharacters(in: .whitespaces) }
        if stem.isEmpty { stem = "upload" }
        return ext.isEmpty ? stem : stem + "." + ext.lowercased()
    }

    /// `dir/name`, or `dir/stem-2.ext`, `-3`, … when it's taken.
    static func uniquePath(dir: String, name: String, fm: FileManager = .default) -> String {
        let ext = (name as NSString).pathExtension
        let stem = (name as NSString).deletingPathExtension
        var candidate = dir + "/" + name
        var i = 2
        while fm.fileExists(atPath: candidate) {
            candidate = dir + "/" + stem + "-\(i)" + (ext.isEmpty ? "" : "." + ext)
            i += 1
        }
        return candidate
    }

    // MARK: What Mia sees

    /// `[MC] Daniel uploaded a file (2 of 3): <path> (<mime>, <size>) — note: <caption>`
    static func eventLine(path: String, mime: String, size: Int, caption: String, batch: String) -> String {
        let nOfN = batch.isEmpty ? "" : " (" + batch.replacingOccurrences(of: "/", with: " of ") + ")"
        let note = caption.split(whereSeparator: { $0.isNewline }).map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }.joined(separator: " ")
        return "[MC] Daniel uploaded a file\(nOfN): \(path) (\(mime.isEmpty ? "unknown type" : mime), \(humanSize(size)))"
            + (note.isEmpty ? "" : " — note: \(note)")
    }

    static func humanSize(_ n: Int) -> String {
        if n < 1024 { return "\(n) B" }
        if n < 1024 * 1024 { return String(format: n < 10240 ? "%.1f KB" : "%.0f KB", Double(n) / 1024) }
        return String(format: "%.1f MB", Double(n) / 1_048_576)
    }

    // MARK: Helpers

    static func sha256(of url: URL) -> String {
        guard let h = try? FileHandle(forReadingFrom: url) else { return "" }
        defer { try? h.close() }
        var hasher = SHA256()
        while let chunk = try? h.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func dayStamp(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }

    /// The relay's http(s) origin from the configured relay URL (ws/wss/http/https).
    static func httpOrigin(_ raw: String) -> URL? {
        guard var c = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              c.host != nil else { return nil }
        c.scheme = (c.scheme == "http" || c.scheme == "ws") ? "http" : "https"
        c.path = ""
        c.query = nil
        c.fragment = nil
        return c.url
    }
}
