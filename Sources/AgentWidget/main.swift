import SwiftUI
import AppKit
import Combine

final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    let manager = AgentManager()
    /// Streams the fleet to the remote panel and executes its commands.
    /// Self-managing: connects/disconnects as the remote settings change.
    private(set) var remote: RemoteBridge?
    var statusItem: NSStatusItem!
    var popover: NSPopover!
    private var cancellables = Set<AnyCancellable>()

    /// Braille spinner frames, cycled in the menu bar while any agent works so
    /// the icon itself reads as "live" without opening anything.
    private let spinnerFrames = Array("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")
    private var spinnerIndex = 0
    private var spinnerTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Pure menu-bar app: no Dock icon, no window. The status item is the only
        // way in; clicking it pops the UI open as a transient popover that closes
        // when you click away.
        NSApp.setActivationPolicy(.accessory)

        // Ask for notification permission + enable real banners (when bundled).
        Notifier.shared.configure()

        // Bring the remote panel bridge up (it no-ops unless enabled in settings).
        remote = RemoteBridge(manager: manager)

        // A frosted-glass popover hosting the same root UI, anchored to the icon.
        let pop = NSPopover()
        pop.behavior = .transient
        pop.animates = true
        pop.appearance = NSAppearance(named: .vibrantDark)
        pop.delegate = self
        pop.contentSize = NSSize(width: 460, height: 700)
        pop.contentViewController = GlassHostingController(
            rootView: RootView()
                .environmentObject(manager)
                .environmentObject(Settings.shared)
        )
        popover = pop

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.action = #selector(togglePopover)
            button.target = self
            button.imagePosition = .imageLeading
            button.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        }
        renderStatusItem(manager.summary)

        // Keep the menu-bar icon in lock-step with the fleet so it's a live,
        // glanceable readout even while the popover is closed.
        manager.$summary
            .receive(on: RunLoop.main)
            .sink { [weak self] in self?.renderStatusItem($0) }
            .store(in: &cancellables)

        // Advance the spinner ~8fps; cheap and only matters while working.
        let st = Timer(timeInterval: 0.12, repeats: true) { [weak self] _ in
            guard let self, self.manager.summary.active > 0 else { return }
            self.spinnerIndex = (self.spinnerIndex + 1) % self.spinnerFrames.count
            self.renderStatusItem(self.manager.summary)
        }
        RunLoop.main.add(st, forMode: .common)
        spinnerTimer = st
    }

    /// The symbol+tint last drawn into the menu bar, so we only rebuild the
    /// (relatively costly) NSImage when the state actually changes — not on every
    /// 8fps spinner frame, where only the title character moves.
    private var lastRenderedSymbol: String?
    private var lastRenderedTint: NSColor?

    /// Reflect fleet state in the menu bar: a bolt while anything's working, a
    /// pause badge when agents are waiting on you, a calm sparkle when idle, and
    /// the working count alongside it.
    private func renderStatusItem(_ s: FleetSummary) {
        guard let button = statusItem.button else { return }

        let symbol: String
        let tint: NSColor?
        if s.active > 0 {
            symbol = "bolt.fill"; tint = .systemGreen
        } else if s.attention > 0 {
            symbol = "exclamationmark.bubble.fill"; tint = .systemYellow
        } else if s.total > 0 {
            symbol = "checkmark.seal.fill"; tint = .secondaryLabelColor
        } else {
            symbol = "sparkles"; tint = nil
        }

        // The icon image only depends on (symbol, tint), which change a handful of
        // times a minute — rebuilding it on every spinner tick would allocate a new
        // NSImage ~8×/sec for nothing. Skip the rebuild when neither changed.
        if symbol != lastRenderedSymbol || tint != lastRenderedTint {
            lastRenderedSymbol = symbol
            lastRenderedTint = tint
            let img = NSImage(systemSymbolName: symbol, accessibilityDescription: "Agents")
            if let tint, let img {
                let cfg = NSImage.SymbolConfiguration(paletteColors: [tint])
                button.image = img.withSymbolConfiguration(cfg)
            } else {
                button.image = img
            }
        }

        if s.active > 0 {
            button.title = " \(spinnerFrames[spinnerIndex]) \(s.active)"
        } else if s.attention > 0 {
            button.title = " \(s.attention)"
        } else {
            button.title = ""
        }
        button.toolTip = s.total == 0
            ? "No active agents"
            : "\(s.active) working · \(s.idle) idle · \(s.done) done"
    }

    /// Clicking the menu-bar icon toggles the popover open/closed.
    @objc func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
            // Pull the popover window in front so it can take key/focus for input.
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    // MARK: NSPopoverDelegate — drives the manager's adaptive poll cadence.

    func popoverDidShow(_ notification: Notification) {
        manager.popoverVisible = true
    }

    func popoverDidClose(_ notification: Notification) {
        manager.popoverVisible = false
    }
}

/// Hosts the SwiftUI root over a behind-window `NSVisualEffectView`, so the
/// popover floats as frosted obsidian glass: whatever's on the desktop behind
/// the menu bar blurs softly through the aurora instead of an opaque panel.
final class GlassHostingController<Content: View>: NSViewController {
    private let hosting: NSHostingController<Content>

    init(rootView: Content) {
        hosting = NSHostingController(rootView: rootView)
        super.init(nibName: nil, bundle: nil)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func loadView() {
        let effect = NSVisualEffectView()
        effect.material = .underWindowBackground   // deep, desktop-sampling blur
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.autoresizingMask = [.width, .height]

        addChild(hosting)
        // NSHostingView is transparent where the SwiftUI content is, so the
        // lowered-opacity aurora lets the glass show through.
        hosting.view.frame = effect.bounds
        hosting.view.autoresizingMask = [.width, .height]
        effect.addSubview(hosting.view)

        view = effect
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
