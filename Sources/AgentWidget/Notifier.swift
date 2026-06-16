import Foundation
import UserNotifications
import AppKit

/// Delivers native macOS notifications.
///
/// When the app runs as a proper `.app` bundle (it has a bundle identifier) we
/// use the real `UserNotifications` framework — genuine banners, owned by this
/// app, with sound. When it's run as a bare `swift build` executable (no bundle
/// id) `UNUserNotificationCenter` would crash, so we fall back to `osascript`,
/// which still posts *something* but is attributed to Script Editor.
///
/// ⇒ For real banners, launch the bundled app (see bundle.sh / `make run`).
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    /// True when we can use the real framework — i.e. we're inside a bundle.
    private let bundled = Bundle.main.bundleIdentifier != nil
    private var authorized = false

    private let queue = DispatchQueue(label: "agentwidget.notifier", qos: .utility)
    private var lastFire: [String: Date] = [:]
    private let minGap: TimeInterval = 2

    private override init() { super.init() }

    /// Call once at launch (from AppDelegate). Wires up the delegate so banners
    /// appear even though we're a menu-bar accessory, and asks permission.
    func configure() {
        guard bundled else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, _ in
            self?.authorized = granted
        }
    }

    func post(title: String, subtitle: String? = nil, body: String, sound: Bool, dedupeKey: String? = nil) {
        let key = dedupeKey ?? title + body
        let now = Date()
        if let last = lastFire[key], now.timeIntervalSince(last) < minGap { return }
        lastFire[key] = now

        if bundled {
            postViaFramework(title: title, subtitle: subtitle, body: body, sound: sound, key: key)
        } else {
            postViaOsascript(title: title, subtitle: subtitle, body: body, sound: sound)
        }
    }

    // MARK: UserNotifications (bundled)

    private func postViaFramework(title: String, subtitle: String?, body: String, sound: Bool, key: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        if let subtitle { content.subtitle = subtitle }
        content.body = body
        content.sound = sound ? .default : nil
        // A *unique* identifier every time. Reusing `key` makes the system
        // silently update the prior notification in place — no banner re-alert
        // and, crucially, no sound. Our own throttle (minGap) handles dedup.
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    /// Show as a banner + sound even while our (accessory) app is "active".
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    // MARK: osascript fallback (bare executable)

    private func postViaOsascript(title: String, subtitle: String?, body: String, sound: Bool) {
        let soundClause = sound ? " sound name \"Glass\"" : ""
        let subtitleClause = subtitle.map { " subtitle \(quote($0))" } ?? ""
        let script = "display notification \(quote(body)) with title \(quote(title))\(subtitleClause)\(soundClause)"
        queue.async {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            p.arguments = ["-e", script]
            p.standardOutput = Pipe(); p.standardError = Pipe()
            try? p.run()
            p.waitUntilExit()
        }
    }

    private func quote(_ s: String) -> String {
        let cleaned = s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
        return "\"\(cleaned)\""
    }
}
