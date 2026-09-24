// Stand-in Mac for the upload E2E (upload-mac-e2e.sh): the REAL
// Sources/AgentWidget/MiaUploads.swift behind a minimal host socket.
//
//   harness selftest                 pure-function checks (names, sizes, event line, origin)
//   harness <port> <token> <root>    connect as host, advertise "upload", save offers under <root>,
//                                    append each [MC] event line to <root>/events.log, answer uploadDone
import Foundation

var failures = 0
func check(_ cond: Bool, _ label: String) {
    print(cond ? "  ✓ \(label)" : "  ✗ \(label)")
    if !cond { failures += 1 }
}

let args = CommandLine.arguments
if args.count > 1 && args[1] == "selftest" {
    check(MiaUploads.safeName("../../etc/passwd.pdf") == "etc passwd.pdf", "safeName strips separators and leading dots")
    check(MiaUploads.safeName("a:b\u{0}c.PDF") == "a b c.pdf", "safeName drops colons/control chars, lowercases the extension")
    check(MiaUploads.safeName("Cafe\u{301} menu.jpg") == "Caf\u{e9} menu.jpg", "safeName normalises to NFC")
    check(MiaUploads.safeName("...") == "upload", "an empty name becomes \"upload\"")
    check(MiaUploads.safeName(String(repeating: "x", count: 400) + ".docx").count == 155, "long names are cut, extension kept")
    check(MiaUploads.humanSize(21) == "21 B" && MiaUploads.humanSize(3008) == "2.9 KB" && MiaUploads.humanSize(921_600) == "900 KB"
          && MiaUploads.humanSize(5_452_595) == "5.2 MB", "humanSize matches the relay/CLI")
    check(MiaUploads.eventLine(path: "/u/a.pdf", mime: "application/pdf", size: 921_600,
                               caption: "Summarise this\n and file it", batch: "1/2")
          == "[MC] Daniel uploaded a file (1 of 2): /u/a.pdf (application/pdf, 900 KB) — note: Summarise this and file it",
          "event line format (batch + one-line note)")
    check(MiaUploads.eventLine(path: "/u/b.m4a", mime: "audio/mp4", size: 10, caption: "", batch: "")
          == "[MC] Daniel uploaded a file: /u/b.m4a (audio/mp4, 10 B)", "event line without note")
    check(MiaUploads.httpOrigin("wss://mc.up.railway.app/ws?x=1")?.absoluteString == "https://mc.up.railway.app", "wss → https origin")
    check(MiaUploads.httpOrigin("ws://localhost:8899")?.absoluteString == "http://localhost:8899", "ws → http origin")
    let tmp = NSTemporaryDirectory() + "mc-uniq-\(getpid())"
    try? FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: tmp + "/a.pdf", contents: Data())
    FileManager.default.createFile(atPath: tmp + "/a-2.pdf", contents: Data())
    check(MiaUploads.uniquePath(dir: tmp, name: "a.pdf") == tmp + "/a-3.pdf", "uniquePath skips taken names")
    try? FileManager.default.removeItem(atPath: tmp)
    exit(failures == 0 ? 0 : 1)
}

let port = args[1], token = args[2], root = args[3]
let relay = URL(string: "http://localhost:\(port)")!
let uploads = MiaUploads(root: root)
let ws = URLSession(configuration: .default)
    .webSocketTask(with: URL(string: "ws://localhost:\(port)/ws?role=host&token=\(token)")!)
ws.resume()

func send(_ o: [String: Any]) {
    let d = try! JSONSerialization.data(withJSONObject: o)
    ws.send(.string(String(data: d, encoding: .utf8)!)) { _ in }
}

func receive() {
    ws.receive { r in
        guard case .success(let m) = r else { print("socket closed"); exit(0) }
        if case .string(let t) = m,
           let o = (try? JSONSerialization.jsonObject(with: Data(t.utf8))) as? [String: Any],
           o["type"] as? String == "upload" {
            DispatchQueue.main.async {
                guard let offer = MiaUploads.offer(from: o) else { return }
                uploads.receive(offer, relay: relay, token: token) { res in
                    switch res {
                    case .success(let s):
                        let line = MiaUploads.eventLine(path: s.path, mime: offer.mime, size: offer.size,
                                                        caption: offer.caption, batch: offer.batch)
                        if let h = FileHandle(forWritingAtPath: root + "/events.log") ?? {
                            FileManager.default.createFile(atPath: root + "/events.log", contents: nil)
                            return FileHandle(forWritingAtPath: root + "/events.log")
                        }() {
                            h.seekToEndOfFile(); h.write(Data((line + "\n").utf8)); try? h.close()
                        }
                        print(line)
                        send(["type": "uploadDone", "id": offer.id, "ok": true, "path": s.path])
                    case .failure(let e):
                        print("refused: \(e.detail)")
                        send(["type": "uploadDone", "id": offer.id, "ok": false, "detail": e.detail])
                    }
                }
            }
        }
        receive()
    }
}
receive()
Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
    send(["type": "snapshot", "caps": ["upload"], "agents": [], "summary": [:]])
}.fire()
RunLoop.main.run()
