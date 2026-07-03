import SwiftUI

/// A launched fleet collapsed into a single item: the mission, a roster summary,
/// and aggregate progress — tap to expand into each member's full AgentCard.
/// Keeps the dashboard readable when you fire off several agents at once.
struct FleetGroupCard: View {
    @EnvironmentObject var manager: AgentManager
    @EnvironmentObject var settings: Settings
    let fleet: FleetGroup
    let members: [AgentRun]
    @State private var expanded = false
    /// Expanded view mode: the at-a-glance task board, or the full agent cards.
    @State private var mode: Mode = .board

    private enum Mode: String, CaseIterable { case board = "Board", cards = "Cards" }

    /// Manager first, then the incoming (already status/recency-sorted) order —
    /// a stable partition rather than a sort, so siblings keep their order.
    private var ordered: [AgentRun] {
        members.filter(\.isManager) + members.filter { !$0.isManager }
    }

    private var working: Int { members.filter { $0.status == .active }.count }
    private var waiting: Int { members.filter { $0.status == .idle && $0.wasActive }.count }
    private var done: Int { members.filter { $0.status == .done }.count }
    private var anyLive: Bool { members.contains { $0.isLive } }
    private var totalCost: Double { members.reduce(0) { $0 + $1.costUSD } }
    private var totalTokens: Int { members.reduce(0) { $0 + $1.totalTokens } }

    private var tint: Color {
        if working > 0 { return AgentRun.workingTint }
        if waiting > 0 { return AgentRun.waitingTint }
        if done == members.count { return AgentRun.doneTint }
        return AgentRun.waitingTint
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if expanded {
                VStack(spacing: 10) {
                    modePicker
                    switch mode {
                    case .board:
                        FleetTaskBoard(fleet: fleet, members: members)
                            .environmentObject(manager)
                    case .cards:
                        VStack(spacing: 9) {
                            ForEach(ordered) { agent in
                                AgentCard(agent: agent)
                                    .environmentObject(manager).environmentObject(settings)
                            }
                        }
                    }
                }
                .padding(.top, 10)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(13)
        .background(cardBackground)
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(LinearGradient(
                    colors: [tint.opacity(anyLive ? 0.6 : 0.22), tint.opacity(anyLive ? 0.22 : 0.08)],
                    startPoint: .top, endPoint: .bottom),
                    lineWidth: anyLive ? 1.3 : 1))
        .shadow(color: anyLive ? tint.opacity(0.24) : .black.opacity(0.18),
                radius: anyLive ? 14 : 7, y: 3)
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 16)
            .fill(.ultraThinMaterial)
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .fill(LinearGradient(colors: [tint.opacity(anyLive ? 0.14 : 0.06), .clear],
                                         startPoint: .topLeading, endPoint: .bottomTrailing)))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(LinearGradient(colors: [.white.opacity(0.16), .clear],
                                           startPoint: .top, endPoint: .center), lineWidth: 1)
                    .blendMode(.plusLighter))
    }

    private var header: some View {
        Button { withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) { expanded.toggle() } } label: {
            HStack(alignment: .top, spacing: 11) {
                emblem
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(fleet.hasManager ? "Fleet" : "Squad")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(tint)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(tint.opacity(0.16)))
                            .overlay(Capsule().stroke(tint.opacity(0.35), lineWidth: 0.5))
                        Text("\(members.count) agents")
                            .font(.system(size: 9.5, weight: .medium)).foregroundStyle(.secondary)
                    }
                    Text(fleet.title)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                    statusLine
                }
                Spacer(minLength: 4)
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.system(size: 11, weight: .bold)).foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
    }

    /// Segmented toggle between the task board and the full per-agent cards.
    private var modePicker: some View {
        HStack(spacing: 4) {
            ForEach(Mode.allCases, id: \.self) { m in
                Button { withAnimation(.spring(response: 0.3)) { mode = m } } label: {
                    Text(m.rawValue)
                        .font(.system(size: 10, weight: mode == m ? .semibold : .regular))
                        .foregroundStyle(mode == m ? .white : .secondary)
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                        .background(Capsule().fill(mode == m
                            ? AnyShapeStyle(tint.opacity(0.5)) : AnyShapeStyle(.clear)))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(Capsule().fill(Color.black.opacity(0.22)))
        .overlay(Capsule().stroke(.white.opacity(0.06), lineWidth: 1))
    }

    /// A stack of agent dots crowned when the fleet has a manager.
    private var emblem: some View {
        ZStack {
            Circle()
                .fill(LinearGradient(colors: [tint.opacity(0.32), tint.opacity(0.12)],
                                     startPoint: .top, endPoint: .bottom))
                .frame(width: 34, height: 34)
                .overlay(Circle().stroke(tint.opacity(0.45), lineWidth: 1))
            Image(systemName: fleet.hasManager ? "person.3.sequence.fill" : "person.3.fill")
                .font(.system(size: 13, weight: .bold)).foregroundStyle(tint)
        }
    }

    private var statusLine: some View {
        HStack(spacing: 10) {
            if working > 0 { miniStat(working, "working", AgentRun.workingTint, pulse: true) }
            if waiting > 0 { miniStat(waiting, "waiting", AgentRun.waitingTint, pulse: true) }
            if done > 0 { miniStat(done, "done", AgentRun.doneTint, pulse: false) }
            Spacer(minLength: 0)
            if totalTokens > 0 {
                Label(BurnFormat.abbrev(totalTokens), systemImage: "flame")
                    .font(.system(size: 9))
                    .foregroundStyle(anyLive ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.tertiary))
                    .labelStyle(.titleAndIcon)
            }
            if totalCost > 0 {
                Label(String(format: "$%.3f", totalCost), systemImage: "dollarsign.circle")
                    .font(.system(size: 9)).foregroundStyle(.tertiary).labelStyle(.titleAndIcon)
            }
        }
        .padding(.top, 1)
    }

    private func miniStat(_ count: Int, _ label: String, _ color: Color, pulse: Bool) -> some View {
        HStack(spacing: 4) {
            PulsingDot(color: color, active: pulse, size: 6)
            Text("\(count)").font(.system(size: 10, weight: .bold)).foregroundStyle(.primary)
            Text(label).font(.system(size: 9)).foregroundStyle(.secondary)
        }
    }
}
