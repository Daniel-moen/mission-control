import SwiftUI
import AppKit

/// The three faces of Mission Control: watch the live fleet, launch a new one,
/// or watch the tokens burn.
enum RootTab: String, CaseIterable, Identifiable {
    case fleet  = "Fleet"
    case launch = "Launch"
    case burn   = "Burn"

    var id: String { rawValue }
    var glyph: String {
        switch self {
        case .fleet:  return "dot.radiowaves.left.and.right"
        case .launch: return "sparkles"
        case .burn:   return "flame.fill"
        }
    }
}

/// Top-level container: a shared living backdrop + brand bar + tab switcher,
/// with the celebration burst floating over everything. The individual tabs
/// (fleet / launch / burn) are pure content and inherit the environment.
struct RootView: View {
    @EnvironmentObject var manager: AgentManager
    @EnvironmentObject var settings: Settings
    @State private var tab: RootTab = .fleet
    @State private var breathe = false
    @Namespace private var tabNS

    /// The whole app is tinted by the fleet's dominant mood — green while
    /// burning, amber when something waits on you, blue when all's done.
    private var fleetTint: Color {
        let s = manager.summary
        if s.active > 0 { return AgentRun.workingTint }
        if s.attention > 0 { return AgentRun.waitingTint }
        if s.total > 0 { return AgentRun.doneTint }
        return .purple
    }

    private var fleetEnergy: Double {
        guard manager.summary.total > 0 else { return 0 }
        return min(1, Double(manager.summary.active) / Double(manager.summary.total))
    }

    /// Is the fleet doing anything worth animating for? Drives whether the
    /// continuous Canvas effects (aurora, equalizers) actually tick or freeze.
    private var fleetBusy: Bool {
        manager.summary.active > 0 || manager.summary.tokensPerSec > 0
    }

    var body: some View {
        ZStack {
            AuroraBackground(tint: tab == .burn ? .orange : fleetTint,
                             energy: tab == .burn ? max(0.5, fleetEnergy) : fleetEnergy,
                             animate: manager.popoverVisible && fleetBusy)
                .ignoresSafeArea()
            // Legibility scrim — deepens top (brand/tabs) and bottom edges so
            // text stays crisp over the translucent aurora glass.
            LinearGradient(colors: [.black.opacity(0.26), .clear, .clear, .black.opacity(0.34)],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea().allowsHitTesting(false)
            VStack(spacing: 0) {
                brandBar
                tabBar
                Group {
                    switch tab {
                    case .fleet:  ContentView()
                    case .launch: LaunchView { withAnimation(.spring(response: 0.4)) { tab = .fleet } }
                    case .burn:   BurnView()
                    }
                }
                .transition(.opacity.combined(with: .scale(scale: 0.985)))
            }
            Celebration(trigger: manager.lastFinishAt)
                .allowsHitTesting(false)
        }
        .frame(width: 460, height: 700)
        .animation(.easeInOut(duration: 0.8), value: fleetTint)
        .onAppear { syncBreath() }
        .onChange(of: manager.popoverVisible) { _ in syncBreath() }
    }

    /// Gentle "breathing" on the brand mark — only animates while the popover is
    /// actually visible, so it respects the app's idle/hidden gating.
    private func syncBreath() {
        withAnimation(manager.popoverVisible
                      ? .easeInOut(duration: 2.4).repeatForever(autoreverses: true)
                      : .easeOut(duration: 0.3)) {
            breathe = manager.popoverVisible
        }
    }

    // MARK: Brand bar

    private var brandBar: some View {
        HStack(spacing: 10) {
            brandMark
            VStack(alignment: .leading, spacing: 1) {
                Text("Mission Control")
                    .font(.system(size: 15, weight: .bold, design: .rounded))
                Text(headline)
                    .font(.system(size: 9)).foregroundStyle(.secondary)
                    .contentTransition(.opacity)
            }
            Spacer()
            Equalizer(color: fleetTint, active: manager.summary.active > 0,
                      intensity: fleetEnergy, bars: 9, animate: manager.popoverVisible)
                .frame(width: 38, height: 18)
                .opacity(0.9)
            settingsMenu
            iconButton("power", help: "Quit") { NSApplication.shared.terminate(nil) }
        }
        .padding(.horizontal, 14).padding(.top, 11).padding(.bottom, 8)
    }

    /// The living brand mark: a gradient disc that gently breathes and emits a
    /// soft expanding halo while the popover is open.
    private var brandMark: some View {
        ZStack {
            Circle()
                .stroke(fleetTint.opacity(0.5), lineWidth: 1)
                .frame(width: 26, height: 26)
                .scaleEffect(breathe ? 1.55 : 1)
                .opacity(breathe ? 0 : 0.6)
            Circle()
                .fill(LinearGradient(colors: [fleetTint, .purple],
                                     startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 26, height: 26)
                .overlay(
                    Circle().stroke(LinearGradient(colors: [.white.opacity(0.5), .clear],
                                                   startPoint: .top, endPoint: .bottom), lineWidth: 1))
                .shadow(color: fleetTint.opacity(0.6), radius: breathe ? 10 : 6)
                .scaleEffect(breathe ? 1.05 : 0.97)
            Image(systemName: "dot.radiowaves.left.and.right")
                .font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
        }
    }

    private var headline: String {
        let s = manager.summary
        if s.total == 0 { return "watching for agents…" }
        if s.active > 0 { return "\(s.active) burning · \(s.total) tracked" }
        if s.attention > 0 { return "\(s.attention) waiting on you" }
        return "all quiet · \(s.total) tracked"
    }

    // MARK: Tab bar

    private var tabBar: some View {
        HStack(spacing: 6) {
            ForEach(RootTab.allCases) { t in
                TabPill(tab: t, selected: tab == t,
                        tint: t == .burn ? .orange : fleetTint,
                        live: t == .burn && manager.summary.tokensPerSec > 0,
                        ns: tabNS) {
                    withAnimation(.spring(response: 0.4, dampingFraction: 0.82)) { tab = t }
                }
            }
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(.ultraThinMaterial).opacity(0.55)
                .overlay(RoundedRectangle(cornerRadius: 14)
                    .stroke(.white.opacity(0.06), lineWidth: 1)))
        .padding(.horizontal, 12).padding(.bottom, 9)
    }

    private func iconButton(_ symbol: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol) }
            .buttonStyle(.borderless).foregroundStyle(.secondary).help(help)
    }

    private var settingsMenu: some View {
        Menu {
            Toggle("Notify when an agent finishes", isOn: $settings.notifyOnFinish)
            Toggle("Notify when an agent waits for you", isOn: $settings.notifyOnWaiting)
            Toggle("Notify when an agent starts", isOn: $settings.notifyOnStart)
            Divider()
            Toggle("Play sound with notifications", isOn: $settings.playSound)
            Toggle("Expand live feeds by default", isOn: $settings.expandFeeds)
            Divider()
            Toggle("📡 Remote panel (iPad)", isOn: $settings.remoteEnabled)
            if !settings.remoteURL.isEmpty {
                Button("Open remote panel in browser") {
                    if let url = panelLink() { NSWorkspace.shared.open(url) }
                }
                Button("Copy panel link (with token)") {
                    guard let url = panelLink() else { return }
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(url.absoluteString, forType: .string)
                }
            }
            Divider()
            Button("🔔 Send test notification") {
                Notifier.shared.post(title: "🔔 Mission Control",
                                     subtitle: "Test notification",
                                     body: "If you can hear this, sound is working.",
                                     sound: settings.playSound,
                                     dedupeKey: "test-\(Date().timeIntervalSince1970)")
            }
        } label: {
            Image(systemName: "slider.horizontal.3")
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden)
        .frame(width: 20).foregroundStyle(.secondary).help("Settings")
    }

    /// The remote panel URL with the token baked in — the link you open on the
    /// iPad once; the panel stores the token locally after that.
    private func panelLink() -> URL? {
        var raw = settings.remoteURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        if !raw.contains("://") { raw = "https://" + raw }
        guard var comps = URLComponents(string: raw) else { return nil }
        let token = settings.remoteToken.trimmingCharacters(in: .whitespacesAndNewlines)
        if !token.isEmpty { comps.queryItems = [URLQueryItem(name: "token", value: token)] }
        return comps.url
    }
}

/// One segmented tab — fills with its accent when selected, and the Burn tab
/// flickers a tiny flame when tokens are actively being spent.
struct TabPill: View {
    let tab: RootTab
    let selected: Bool
    let tint: Color
    var live: Bool = false
    var ns: Namespace.ID
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                FlickerIcon(systemName: tab.glyph, live: live)
                Text(tab.rawValue).font(.system(size: 11, weight: selected ? .bold : .medium))
            }
            .foregroundStyle(selected ? .white : .secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 7)
            .background {
                if selected {
                    // A single shared highlight that glides between tabs.
                    RoundedRectangle(cornerRadius: 10)
                        .fill(LinearGradient(colors: [tint, tint.opacity(0.72)],
                                             startPoint: .top, endPoint: .bottom))
                        .overlay(RoundedRectangle(cornerRadius: 10)
                            .stroke(LinearGradient(colors: [.white.opacity(0.4), .clear],
                                                   startPoint: .top, endPoint: .bottom), lineWidth: 1))
                        .shadow(color: tint.opacity(0.45), radius: 8, y: 2)
                        .matchedGeometryEffect(id: "tabSelection", in: ns)
                }
            }
        }
        .buttonStyle(.plain)
    }
}

/// A small SF Symbol that softly throbs while `live` — a macOS-13-safe stand-in
/// for `symbolEffect(.pulse)`.
struct FlickerIcon: View {
    let systemName: String
    var live: Bool
    @State private var on = false

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 10, weight: .bold))
            .opacity(live ? (on ? 1 : 0.45) : 1)
            .scaleEffect(live && on ? 1.12 : 1)
            .onAppear { if live { on = true } }
            .onChange(of: live) { v in on = v }
            .animation(live ? .easeInOut(duration: 0.6).repeatForever(autoreverses: true) : .default, value: on)
    }
}
