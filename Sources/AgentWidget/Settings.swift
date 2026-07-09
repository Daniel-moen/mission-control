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
    /// Which terminal app the user wants new agents launched in. Stored as the
    /// `LaunchTerminal` raw value; see `launchTerminal` for the typed accessor.
    @Published var launchTerminalID: String {
        didSet { defaults.set(launchTerminalID, forKey: Keys.launchTerminalID) }
    }
    /// Open new agents as a tab of the terminal's existing window instead of a
    /// window of their own — the only way to launch one without knocking a
    /// full-screen terminal out of its space. Ignored by terminals with no tab
    /// backend, which always get a fresh window.
    @Published var launchInNewTab: Bool {
        didSet { defaults.set(launchInNewTab, forKey: Keys.launchInNewTab) }
    }
    /// Mirror the fleet to the remote panel (Railway relay) so it can be watched
    /// and steered from another device.
    @Published var remoteEnabled: Bool {
        didSet { defaults.set(remoteEnabled, forKey: Keys.remoteEnabled) }
    }
    /// Base https:// URL of the deployed relay (e.g. the Railway domain).
    @Published var remoteURL: String {
        didSet { defaults.set(remoteURL, forKey: Keys.remoteURL) }
    }
    /// Shared secret both the app and the panel present to the relay.
    @Published var remoteToken: String {
        didSet { defaults.set(remoteToken, forKey: Keys.remoteToken) }
    }

    /// Typed view of the user's chosen launch terminal, defaulting to the
    /// always-present Terminal.app when nothing's been picked yet.
    var launchTerminal: TerminalBridge.LaunchTerminal {
        get { TerminalBridge.LaunchTerminal(rawValue: launchTerminalID) ?? .terminal }
        set { launchTerminalID = newValue.rawValue }
    }

    private let defaults = UserDefaults.standard
    private enum Keys {
        static let notifyOnFinish = "notifyOnFinish"
        static let notifyOnWaiting = "notifyOnWaiting"
        static let notifyOnStart = "notifyOnStart"
        static let playSound = "playSound"
        static let expandFeeds = "expandFeeds"
        static let lastLaunchDir = "lastLaunchDir"
        static let launchTerminalID = "launchTerminalID"
        static let launchInNewTab = "launchInNewTab"
        static let remoteEnabled = "remoteEnabled"
        static let remoteURL = "remoteURL"
        static let remoteToken = "remoteToken"
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
        launchTerminalID = store.string(forKey: Keys.launchTerminalID) ?? TerminalBridge.LaunchTerminal.terminal.rawValue
        launchInNewTab = bool(Keys.launchInNewTab, default: true)
        remoteEnabled = bool(Keys.remoteEnabled, default: false)
        remoteURL = store.string(forKey: Keys.remoteURL) ?? ""
        remoteToken = store.string(forKey: Keys.remoteToken) ?? ""
    }
}
