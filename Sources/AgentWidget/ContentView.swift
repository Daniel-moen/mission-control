import SwiftUI
import AppKit

enum FleetFilter: String, CaseIterable { case all = "All", working = "Working", waiting = "Waiting", done = "Done" }
enum SortMode: String, CaseIterable { case smart = "Smart", recent = "Recent", cost = "Cost", name = "Name" }

struct ContentView: View {
    @EnvironmentObject var manager: AgentManager
    @EnvironmentObject var settings: Settings
    @State private var search = ""
    @State private var filter: FleetFilter = .all
    @State private var sort: SortMode = .smart
    @State private var showBroadcast = false
    @State private var broadcast = ""
    @State private var broadcastResult: String?

    // MARK: Derived

    private var visible: [AgentRun] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        var list = manager.agents.filter { a in
            (q.isEmpty || a.prompt.lowercased().contains(q) || a.folderName.lowercased().contains(q))
            && matchesFilter(a)
        }
        switch sort {
        case .smart:  break   // manager already orders by status then recency
        case .recent: list.sort { $0.lastModified > $1.lastModified }
        case .cost:   list.sort { $0.costUSD > $1.costUSD }
        case .name:   list.sort { $0.folderName.localizedCaseInsensitiveCompare($1.folderName) == .orderedAscending }
        }
        return list
    }

    /// One entry in the fleet list: either a standalone agent or a launched
    /// group of them. Groups slot in at the position of their first visible
    /// member so the chosen sort order still reads naturally.
    private enum Row: Identifiable {
        case solo(AgentRun)
        case group(FleetGroup, [AgentRun])
        var id: String {
            switch self {
            case .solo(let a):     return "solo-\(a.id)"
            case .group(let f, _): return "group-\(f.id.uuidString)"
            }
        }
    }

    private var rows: [Row] {
        let list = visible
        // Bucket visible agents by the fleet they belong to.
        var byFleet: [UUID: [AgentRun]] = [:]
        for a in list { if let fid = a.fleetId { byFleet[fid, default: []].append(a) } }
        var out: [Row] = []
        var emitted = Set<UUID>()
        for a in list {
            if let fid = a.fleetId, let members = byFleet[fid], members.count >= 2,
               let fleet = manager.fleet(for: fid) {
                if emitted.insert(fid).inserted { out.append(.group(fleet, members)) }
            } else {
                // No fleet, or the group has only one visible member — show solo.
                out.append(.solo(a))
            }
        }
        return out
    }

    private func matchesFilter(_ a: AgentRun) -> Bool {
        switch filter {
        case .all:     return true
        case .working: return a.status == .active
        case .waiting: return a.status == .idle
        case .done:    return a.status == .done
        }
    }

    private var controllableCount: Int {
        manager.agents.filter { $0.terminal?.controllable ?? false }.count
    }

    private var fleetTint: Color {
        let s = manager.summary
        if s.active > 0 { return AgentRun.workingTint }
        if s.attention > 0 { return AgentRun.waitingTint }
        if s.total > 0 { return AgentRun.doneTint }
        return .purple
    }

    var body: some View {
        VStack(spacing: 0) {
            dashboard
            filterRow
            if manager.agents.count > 4 || !search.isEmpty { searchBar }
            agentList
            if showBroadcast { broadcastBar }
        }
    }

    // MARK: Dashboard

    private var dashboard: some View {
        HStack(spacing: 7) {
            StatChip(count: manager.summary.active, label: "working",
                     color: AgentRun.workingTint, pulse: manager.summary.active > 0)
            StatChip(count: manager.summary.attention, label: "waiting",
                     color: AgentRun.waitingTint, pulse: manager.summary.attention > 0)
            StatChip(count: manager.summary.done, label: "done",
                     color: AgentRun.doneTint, pulse: false)
            Spacer()
            if manager.summary.totalTurns > 0 || manager.summary.totalCost > 0 {
                VStack(alignment: .trailing, spacing: 0) {
                    HStack(spacing: 3) {
                        RollingNumber(value: Double(manager.summary.totalTurns), size: 13)
                            .foregroundStyle(.primary)
                            .animation(.spring(response: 0.5), value: manager.summary.totalTurns)
                        Text("turns").font(.system(size: 9)).foregroundStyle(.secondary)
                    }
                    if manager.summary.totalCost > 0 {
                        Text(String(format: "$%.4f spent", manager.summary.totalCost))
                            .font(.system(size: 8.5)).foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .padding(.horizontal, 12).padding(.bottom, 7)
    }

    private var filterRow: some View {
        HStack(spacing: 6) {
            ForEach(FleetFilter.allCases, id: \.self) { f in
                FilterPill(title: f.rawValue, selected: filter == f, tint: fleetTint) {
                    withAnimation(.spring(response: 0.3)) { filter = f }
                }
            }
            Spacer()
            if controllableCount > 1 {
                Button {
                    withAnimation(.spring(response: 0.3)) { showBroadcast.toggle() }
                } label: {
                    Image(systemName: "megaphone\(showBroadcast ? ".fill" : "")")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(showBroadcast ? AnyShapeStyle(fleetTint) : AnyShapeStyle(.secondary))
                .help("Broadcast to all \(controllableCount) agents")
            }
            Menu {
                Picker("Sort", selection: $sort) {
                    ForEach(SortMode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
            } label: {
                Image(systemName: "arrow.up.arrow.down")
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden)
            .frame(width: 18).foregroundStyle(.secondary).help("Sort agents")
        }
        .padding(.horizontal, 12).padding(.bottom, 7)
    }

    private var searchBar: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").font(.caption2).foregroundStyle(.tertiary)
            TextField("Filter by task or folder…", text: $search)
                .textFieldStyle(.plain).font(.system(size: 11))
            if !search.isEmpty {
                Button { search = "" } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.borderless).foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 11).padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 9).fill(.ultraThinMaterial)
                .overlay(RoundedRectangle(cornerRadius: 9)
                    .stroke(.white.opacity(0.07), lineWidth: 1)))
        .padding(.horizontal, 12).padding(.bottom, 7)
    }

    // MARK: List

    private var agentList: some View {
        ScrollView {
            LazyVStack(spacing: 9) {
                if manager.agents.isEmpty {
                    emptyState
                } else if visible.isEmpty {
                    Text(search.isEmpty ? "Nothing in “\(filter.rawValue)”." : "No agents match “\(search)”.")
                        .font(.callout).foregroundStyle(.secondary).padding(.top, 50)
                } else {
                    ForEach(rows) { row in
                        Group {
                            switch row {
                            case .solo(let agent):
                                AgentCard(agent: agent)
                            case .group(let fleet, let members):
                                FleetGroupCard(fleet: fleet, members: members)
                            }
                        }
                        .environmentObject(manager).environmentObject(settings)
                        .transition(.asymmetric(
                            insertion: .scale(scale: 0.94).combined(with: .opacity),
                            removal: .scale(scale: 0.9).combined(with: .opacity)))
                    }
                }
            }
            .padding(12)
            .animation(.spring(response: 0.38, dampingFraction: 0.82), value: rows.map(\.id))
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            ZStack {
                ForEach(0..<3) { i in
                    Circle().stroke(fleetTint.opacity(0.25), lineWidth: 1)
                        .frame(width: CGFloat(30 + i * 26), height: CGFloat(30 + i * 26))
                }
                Image(systemName: "antenna.radiowaves.left.and.right")
                    .font(.system(size: 24))
                    .foregroundStyle(LinearGradient(colors: [fleetTint, .purple],
                                                    startPoint: .top, endPoint: .bottom))
            }
            .frame(height: 90)
            Text("The fleet is quiet").font(.callout.weight(.semibold))
            Text("Start a `claude` session in any terminal\nand it lights up here automatically.")
                .multilineTextAlignment(.center).font(.caption).foregroundStyle(.secondary)
        }
        .padding(.top, 60)
    }

    // MARK: Broadcast

    private var broadcastBar: some View {
        VStack(spacing: 4) {
            Divider()
            HStack(spacing: 6) {
                Image(systemName: "megaphone.fill").font(.caption).foregroundStyle(fleetTint)
                TextField("Message all \(controllableCount) agents…", text: $broadcast, axis: .vertical)
                    .textFieldStyle(.roundedBorder).font(.system(size: 11))
                    .lineLimit(1...3).onSubmit(sendBroadcast)
                Button(action: sendBroadcast) { Image(systemName: "paperplane.fill") }
                    .buttonStyle(.borderless)
                    .disabled(broadcast.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if let r = broadcastResult {
                Text(r).font(.caption2).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }

    private func sendBroadcast() {
        let text = broadcast.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let n = manager.broadcast(text)
        broadcast = ""
        broadcastResult = n == 0 ? "Couldn't reach any agent." : "Sent to \(n) agent\(n == 1 ? "" : "s")."
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { broadcastResult = nil }
    }
}

// MARK: - Small components

struct StatChip: View {
    let count: Int
    let label: String
    let color: Color
    let pulse: Bool

    private var lit: Bool { count > 0 }

    var body: some View {
        HStack(spacing: 5) {
            PulsingDot(color: color, active: pulse)
            RollingNumber(value: Double(count), size: 13)
                .foregroundStyle(lit ? .primary : .secondary)
            Text(label).font(.system(size: 10)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(.ultraThinMaterial)
                .overlay(RoundedRectangle(cornerRadius: 10)
                    .fill(color.opacity(lit ? 0.16 : 0.04)))
                .overlay(  // hairline top sheen
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(LinearGradient(colors: [.white.opacity(0.14), .clear],
                                               startPoint: .top, endPoint: .bottom), lineWidth: 1))
        )
        .overlay(RoundedRectangle(cornerRadius: 10)
            .stroke(color.opacity(lit ? 0.38 : 0.08), lineWidth: 1))
        .shadow(color: pulse ? color.opacity(0.28) : .clear, radius: 8)
        .animation(.spring(response: 0.4, dampingFraction: 0.8), value: count)
    }
}

struct FilterPill: View {
    let title: String
    let selected: Bool
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 10.5, weight: selected ? .semibold : .regular))
                .foregroundStyle(selected ? .white : .secondary)
                .padding(.horizontal, 11).padding(.vertical, 5)
                .background(
                    Capsule().fill(selected
                        ? AnyShapeStyle(LinearGradient(colors: [tint, tint.opacity(0.78)],
                                                       startPoint: .top, endPoint: .bottom))
                        : AnyShapeStyle(.ultraThinMaterial)))
                .overlay(Capsule().stroke(selected ? tint.opacity(0.5) : .white.opacity(0.07), lineWidth: 1))
                .shadow(color: selected ? tint.opacity(0.35) : .clear, radius: 6, y: 1)
        }
        .buttonStyle(.plain)
    }
}

/// A status dot that softly pulses while active — the heartbeat of the fleet.
struct PulsingDot: View {
    let color: Color
    let active: Bool
    var size: CGFloat = 7
    @State private var on = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .overlay(
                Circle().stroke(color, lineWidth: 1.5)
                    .scaleEffect(on ? 2.2 : 1)
                    .opacity(on ? 0 : 0.7))
            .onAppear { if active { on = true } }
            .onChange(of: active) { v in on = v }
            .animation(active ? .easeOut(duration: 1.1).repeatForever(autoreverses: false) : .default, value: on)
    }
}
