import SwiftUI

/// The expanded fleet's "mission control board": a compact, glanceable view of
/// what every worker is doing right now — its live activity, its TodoWrite
/// checklist (what's done, what's in flight, what's queued) — topped by a strip
/// of aggregate fleet metrics. Where the per-card view answers "how is this one
/// agent?", the board answers "how is the whole squad, at a glance?".
struct FleetTaskBoard: View {
    @EnvironmentObject var manager: AgentManager
    let fleet: FleetGroup
    let members: [AgentRun]

    /// Manager first, then the incoming (status/recency-sorted) order.
    private var ordered: [AgentRun] {
        members.filter(\.isManager) + members.filter { !$0.isManager }
    }

    private var tint: Color {
        if members.contains(where: { $0.status == .active }) { return AgentRun.workingTint }
        if members.contains(where: { $0.status == .idle && $0.wasActive }) { return AgentRun.waitingTint }
        return AgentRun.doneTint
    }

    // Fleet-wide rollups for the metrics strip.
    private var completedSteps: Int { members.reduce(0) { $0 + $1.completedSteps } }
    private var totalSteps: Int { members.reduce(0) { $0 + $1.totalSteps } }
    private var fleetProgress: Double? {
        guard totalSteps > 0 else { return nil }
        return Double(completedSteps) / Double(totalSteps)
    }
    private var totalTurns: Int { members.reduce(0) { $0 + $1.numTurns } }
    private var totalCost: Double { members.reduce(0) { $0 + $1.costUSD } }
    private var burnRate: Double { members.reduce(0) { $0 + $1.tokensPerSec() } }
    private var anyLive: Bool { members.contains { $0.isLive } }

    /// Fleet uptime = oldest member's age, formatted like an AgentRun's.
    private var elapsedLabel: String {
        guard let first = members.map(\.firstSeen).min() else { return "—" }
        let t = Int(Date().timeIntervalSince(first))
        if t < 60 { return "\(t)s" }
        if t < 3600 { return "\(t / 60)m\(String(format: "%02d", t % 60))s" }
        return "\(t / 3600)h\(String(format: "%02d", (t % 3600) / 60))m"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            metricsStrip
            VStack(spacing: 8) {
                ForEach(Array(ordered.enumerated()), id: \.element.id) { idx, agent in
                    WorkerTaskRow(agent: agent, index: workerIndex(for: agent, at: idx))
                        .environmentObject(manager)
                }
            }
        }
    }

    /// Stable 1-based label for non-manager workers; nil for the manager.
    private func workerIndex(for agent: AgentRun, at idx: Int) -> Int? {
        guard !agent.isManager else { return nil }
        let workers = ordered.filter { !$0.isManager }
        return (workers.firstIndex { $0 === agent } ?? 0) + 1
    }

    // MARK: Aggregate metrics

    private var metricsStrip: some View {
        VStack(spacing: 8) {
            if let p = fleetProgress {
                VStack(alignment: .leading, spacing: 4) {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.secondary.opacity(0.16))
                            Capsule()
                                .fill(LinearGradient(colors: Color.gradientPair(tint),
                                                     startPoint: .leading, endPoint: .trailing))
                                .frame(width: max(5, geo.size.width * p))
                                .shadow(color: tint.opacity(0.5), radius: 3)
                        }
                    }
                    .frame(height: 6)
                    HStack(spacing: 4) {
                        Image(systemName: "checklist").font(.system(size: 8))
                        Text("\(completedSteps)/\(totalSteps) tasks across the fleet · \(Int(p * 100))%")
                    }
                    .font(.system(size: 9)).foregroundStyle(.tertiary)
                }
            }
            HStack(spacing: 7) {
                metric("flame", burnRate >= 1 ? "\(BurnFormat.abbrev(Int(burnRate)))/s" : "idle",
                       "burn", anyLive && burnRate >= 1 ? .orange : .secondary)
                metric("arrow.triangle.2.circlepath", "\(totalTurns)", "turns", .cyan)
                if totalCost > 0 {
                    metric("dollarsign.circle", String(format: "$%.3f", totalCost), "spent", .green)
                }
                metric("clock", elapsedLabel, "elapsed", tint)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 11).fill(Color.black.opacity(0.22)))
        .overlay(RoundedRectangle(cornerRadius: 11).stroke(.white.opacity(0.06), lineWidth: 1))
    }

    private func metric(_ symbol: String, _ value: String, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 3) {
            Label(value, systemImage: symbol)
                .font(.system(size: 11, weight: .bold, design: .rounded)).monospacedDigit()
                .labelStyle(.titleAndIcon).foregroundStyle(color).lineLimit(1)
            Text(label).font(.system(size: 8, weight: .medium)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

/// One worker on the board: a status-ringed header (name, role, live metrics),
/// the single line describing what it's doing this instant, a step progress bar,
/// and its full todo checklist. Observes the agent so todos/tokens animate live.
struct WorkerTaskRow: View {
    @EnvironmentObject var manager: AgentManager
    @ObservedObject var agent: AgentRun
    /// 1-based worker number, or nil for the fleet manager.
    let index: Int?
    /// Checklist starts open — the whole point of the board is seeing the tasks —
    /// but each worker can be folded away to keep a big fleet scannable.
    @State private var showTasks = true

    private var tint: Color { agent.accent }

    /// "Manager", or "Worker 3" — falls back to the folder name for stray agents.
    private var roleLabel: String {
        if agent.isManager { return "Manager" }
        if let i = index { return "Worker \(i)" }
        return agent.folderName
    }

    /// The single most useful "what is it doing right now" line: the active todo's
    /// running form if there is one, else the latest parsed activity.
    private var nowDoing: String {
        if let active = agent.todos.first(where: { $0.status == "in_progress" }) {
            return active.activeForm.isEmpty ? active.content : active.activeForm
        }
        if let last = agent.log.last, !last.text.isEmpty { return last.text }
        return agent.activity
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            header
            if agent.status != .done {
                HStack(alignment: .top, spacing: 5) {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.system(size: 8)).foregroundStyle(tint.opacity(0.7))
                        .padding(.top, 1)
                    Text(nowDoing)
                        .font(.system(size: 10.5)).foregroundStyle(.secondary)
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                }
            }
            if !agent.todos.isEmpty { progressBar }
            if showTasks, !agent.todos.isEmpty { checklist }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 11).fill(.ultraThinMaterial))
        .overlay(RoundedRectangle(cornerRadius: 11)
            .fill(LinearGradient(colors: [tint.opacity(agent.isLive ? 0.10 : 0.04), .clear],
                                 startPoint: .topLeading, endPoint: .bottomTrailing)))
        .overlay(RoundedRectangle(cornerRadius: 11)
            .stroke(tint.opacity(agent.isLive ? 0.4 : 0.16), lineWidth: 1))
    }

    private var header: some View {
        HStack(spacing: 9) {
            StatusRing(progress: agent.progress, color: tint, active: agent.isLive,
                       glyph: agent.status.glyph, size: 26, animate: manager.popoverVisible)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    if agent.isManager {
                        Image(systemName: "crown.fill").font(.system(size: 8)).foregroundStyle(tint)
                    }
                    Text(roleLabel).font(.system(size: 11.5, weight: .semibold))
                    Text("·").foregroundStyle(.tertiary)
                    Text(agent.status.label).font(.system(size: 9.5, weight: .medium)).foregroundStyle(tint)
                }
                Text(agent.folderName).font(.system(size: 9)).foregroundStyle(.tertiary).lineLimit(1)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 2) {
                if agent.totalTokens > 0 {
                    Label(BurnFormat.abbrev(agent.totalTokens), systemImage: "flame")
                        .font(.system(size: 9, weight: .medium)).labelStyle(.titleAndIcon)
                        .foregroundStyle(agent.isLive ? AnyShapeStyle(.orange) : AnyShapeStyle(.tertiary))
                }
                if agent.numTurns > 0 {
                    Text("\(agent.numTurns) turns").font(.system(size: 8.5)).foregroundStyle(.tertiary)
                }
            }
            // Tap target to fold the checklist away.
            if !agent.todos.isEmpty {
                Button { withAnimation(.spring(response: 0.3)) { showTasks.toggle() } } label: {
                    Image(systemName: showTasks ? "chevron.up" : "chevron.down")
                        .font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var progressBar: some View {
        HStack(spacing: 7) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.16))
                    Capsule()
                        .fill(LinearGradient(colors: Color.gradientPair(tint),
                                             startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(4, geo.size.width * (agent.progress ?? 0)))
                }
            }
            .frame(height: 4)
            Text("\(agent.completedSteps)/\(agent.totalSteps)")
                .font(.system(size: 9, weight: .semibold, design: .rounded)).monospacedDigit()
                .foregroundStyle(.tertiary)
        }
    }

    private var checklist: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(agent.todos) { todo in
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: icon(for: todo.status))
                        .font(.system(size: 9.5))
                        .foregroundStyle(todo.status == "completed" ? tint :
                                            (todo.status == "in_progress" ? Color.yellow : Color.secondary))
                    Text(todo.status == "in_progress" && !todo.activeForm.isEmpty ? todo.activeForm : todo.content)
                        .font(.system(size: 10))
                        .strikethrough(todo.status == "completed", color: .secondary)
                        .foregroundStyle(todo.status == "completed" ? .secondary :
                                            (todo.status == "in_progress" ? .primary : Color.secondary))
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.18)))
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    private func icon(for status: String) -> String {
        switch status {
        case "completed":   return "checkmark.circle.fill"
        case "in_progress": return "circle.dotted"
        default:            return "circle"
        }
    }
}
