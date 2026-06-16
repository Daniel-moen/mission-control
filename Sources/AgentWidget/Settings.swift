import Foundation
import Combine

/// User-tunable preferences, persisted in UserDefaults. Kept tiny on purpose:
/// the widget should feel like an appliance, not a control panel.
final class Settings: ObservableObject {
    static let shared = Settings()

    @Published var notifyOnFinish: Bool {
        didSet { defaults.set(notifyOnFinish, forKey: Keys.notifyOnFinish) }
    }
    @Published var notifyOnWaiting: Bool {
        didSet { defaults.set(notifyOnWaiting, forKey: Keys.notifyOnWaiting) }
    }
    @Published var notifyOnStart: Bool {
        didSet { defaults.set(notifyOnStart, forKey: Keys.notifyOnStart) }
    }
    @Published var playSound: Bool {
        didSet { defaults.set(playSound, forKey: Keys.playSound) }
    }
    /// Show the running activity feed inside each card by default.
    @Published var expandFeeds: Bool {
        didSet { defaults.set(expandFeeds, forKey: Keys.expandFeeds) }
    }
    /// Last folder the user launched a fleet into, prefilled next time.
    @Published var lastLaunchDir: String {
        didSet { defaults.set(lastLaunchDir, forKey: Keys.lastLaunchDir) }
    }

    private let defaults = UserDefaults.standard
    private enum Keys {
        static let notifyOnFinish = "notifyOnFinish"
        static let notifyOnWaiting = "notifyOnWaiting"
        static let notifyOnStart = "notifyOnStart"
        static let playSound = "playSound"
        static let expandFeeds = "expandFeeds"
        static let lastLaunchDir = "lastLaunchDir"
    }

    private init() {
        // Default the high-signal notifications on, the chatty one off.
        let store = defaults
        func bool(_ key: String, default def: Bool) -> Bool {
            store.object(forKey: key) == nil ? def : store.bool(forKey: key)
        }
        notifyOnFinish = bool(Keys.notifyOnFinish, default: true)
        notifyOnWaiting = bool(Keys.notifyOnWaiting, default: true)
        notifyOnStart = bool(Keys.notifyOnStart, default: false)
        playSound = bool(Keys.playSound, default: true)
        expandFeeds = bool(Keys.expandFeeds, default: false)
        lastLaunchDir = store.string(forKey: Keys.lastLaunchDir) ?? ""
    }
}
