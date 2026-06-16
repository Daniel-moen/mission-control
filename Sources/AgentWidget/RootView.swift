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

    /// The whole app is tinted by the fleet's dominant mood — green while
    /// burning, amber when something waits on you, blue when all's done.
    private var fleetTint: Color {
        let s = manager.summary
        if s.active > 0 { return Color(red: 0.20, green: 0.92, blue: 0.55) }
        if s.attention > 0 { return Color(red: 1.0, green: 0.80, blue: 0.18) }
        if s.total > 0 { return Color(red: 0.40, green: 0.55, blue: 0.95) }
        return .purple
    }

    private var fleetEnergy: Double {
        guard manager.summary.total > 0 else { return 0 }
        return min(1, Double(manager.summary.active) / Double(manager.summary.total))
    }

    var body: some View {
        ZStack {
            AuroraBackground(tint: tab == .burn ? .orange : fleetTint,
                             energy: tab == .burn ? max(0.5, fleetEnergy) : fleetEnergy)
                .ignoresSafeArea()
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
                .transition(.opacity)
            }
            Celebration(trigger: manager.lastFinishAt)
                .allowsHitTesting(false)
        }
        .frame(width: 460, height: 700)
        .animation(.easeInOut(duration: 0.8), value: fleetTint)
    }

    // MARK: Brand bar

    private var brandBar: some View {
        HStack(spacing: 9) {
            ZStack {
                Circle().fill(LinearGradient(colors: [fleetTint, .purple],
                                             startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 24, height: 24)
                    .shadow(color: fleetTint.opacity(0.6), radius: 6)
                Image(systemName: "dot.radiowaves.left.and.right")
                    .font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text("Mission Control").font(.headline)
                Text(headline).font(.system(size: 9)).foregroundStyle(.secondary)
            }
            Spacer()
            Equalizer(color: fleetTint, active: manager.summary.active > 0,
                      intensity: fleetEnergy, bars: 9)
                .frame(width: 38, height: 18)
                .opacity(0.9)
            settingsMenu
            iconButton("power", help: "Quit") { NSApplication.shared.terminate(nil) }
        }
        .padding(.horizontal, 12).padding(.top, 9).padding(.bottom, 7)
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
                        live: t == .burn && manager.summary.tokensPerSec > 0) {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) { tab = t }
                }
            }
        }
        .padding(.horizontal, 12).padding(.bottom, 8)
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
}

/// One segmented tab — fills with its accent when selected, and the Burn tab
/// flickers a tiny flame when tokens are actively being spent.
struct TabPill: View {
    let tab: RootTab
    let selected: Bool
    let tint: Color
    var live: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                FlickerIcon(systemName: tab.glyph, live: live)
                Text(tab.rawValue).font(.system(size: 11, weight: selected ? .bold : .medium))
            }
            .foregroundStyle(selected ? .white : .secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(selected ? AnyShapeStyle(LinearGradient(colors: [tint, tint.opacity(0.7)],
                                                                  startPoint: .top, endPoint: .bottom))
                                   : AnyShapeStyle(Color.secondary.opacity(0.10)))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(selected ? tint.opacity(0.6) : .clear, lineWidth: 1))
            .shadow(color: selected ? tint.opacity(0.4) : .clear, radius: 5, y: 1)
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
