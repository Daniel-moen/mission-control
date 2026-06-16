import SwiftUI
import AppKit
import Combine

final class AppDelegate: NSObject, NSApplicationDelegate {
    let manager = AgentManager()
    var statusItem: NSStatusItem!
    var popover = NSPopover()
    private var cancellables = Set<AnyCancellable>()

    /// Braille spinner frames, cycled in the menu bar while any agent works so
    /// the icon itself reads as "live" without opening anything.
    private let spinnerFrames = Array("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")
    private var spinnerIndex = 0
    private var spinnerTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Menu-bar agent: no Dock icon.
        NSApp.setActivationPolicy(.accessory)

        // Ask for notification permission + enable real banners (when bundled).
        Notifier.shared.configure()

        popover.contentSize = NSSize(width: 460, height: 700)
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(
            rootView: RootView()
                .environmentObject(manager)
                .environmentObject(Settings.shared)
        )

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

        let img = NSImage(systemSymbolName: symbol, accessibilityDescription: "Agents")
        if let tint, let img {
            let cfg = NSImage.SymbolConfiguration(paletteColors: [tint])
            button.image = img.withSymbolConfiguration(cfg)
        } else {
            button.image = img
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

    @objc func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
