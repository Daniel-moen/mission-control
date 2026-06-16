import SwiftUI

/// The "watch it burn" tab: a live wall of fire whose ferocity tracks the
/// fleet's real token throughput, a glowing running total, and a leaderboard of
/// who's spending the most.
struct BurnView: View {
    @EnvironmentObject var manager: AgentManager

    private var summary: FleetSummary { manager.summary }
    private var tps: Double { summary.tokensPerSec }

    /// 0…1 ferocity for the flames. Rate drives it; a working fleet always keeps
    /// at least a healthy blaze, and a quiet-but-spent fleet smolders.
    private var fireIntensity: Double {
        let fromRate = min(1, tps / 8000)
        if summary.active > 0 { return max(0.32, fromRate) }
        return summary.totalTokens > 0 ? 0.12 : 0.04
    }

    // Token breakdown across the whole fleet.
    private var inputTotal: Int { manager.agents.reduce(0) { $0 + $1.inputTokens } }
    private var cacheTotal: Int { manager.agents.reduce(0) { $0 + $1.cacheReadTokens + $1.cacheCreateTokens } }
    private var outputTotal: Int { summary.outputTokens }

    private var leaders: [AgentRun] {
        manager.agents.filter { $0.totalTokens > 0 }
            .sorted { $0.totalTokens > $1.totalTokens }
            .prefix(5).map { $0 }
    }

    @State private var counterPop: CGFloat = 1.0

    var body: some View {
        ZStack(alignment: .bottom) {
            FireView(intensity: fireIntensity, level: summary.totalTokens)
                .allowsHitTesting(false)
            VStack(spacing: 14) {
                counter
                liveRate
                statRow
                breakdownBar
                leaderboard
                Spacer(minLength: 0)
            }
            .padding(16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Big counter

    private var counter: some View {
        VStack(spacing: 3) {
            Text(BurnFormat.abbrev(summary.totalTokens))
                .font(.system(size: 52, weight: .heavy, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(
                    LinearGradient(
                        colors: [.yellow, .orange, .red],
                        startPoint: .top, endPoint: .bottom
                    )
                )
                .shadow(color: .yellow.opacity(0.4), radius: 4)
                .shadow(color: .orange.opacity(0.85), radius: 14)
                .shadow(color: .red.opacity(0.5), radius: 28)
                .shadow(color: .red.opacity(0.2), radius: 44)
                .contentTransition(.numericText())
                .animation(.spring(response: 0.5), value: summary.totalTokens)
                .scaleEffect(counterPop)
                .onChange(of: summary.totalTokens) { _ in
                    withAnimation(.spring(response: 0.15, dampingFraction: 0.45)) {
                        counterPop = 1.09
                    }
                    withAnimation(.spring(response: 0.4, dampingFraction: 0.55).delay(0.15)) {
                        counterPop = 1.0
                    }
                }
            Text("TOKENS BURNED")
                .font(.system(size: 11, weight: .bold)).tracking(3.5)
                .foregroundStyle(.orange.opacity(0.9))
                .shadow(color: .orange.opacity(0.55), radius: 5)
        }
        .padding(.vertical, 8).padding(.horizontal, 14)
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(Color.black.opacity(0.28))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(
                    LinearGradient(
                        colors: [.yellow.opacity(0.45), .orange.opacity(0.25), .red.opacity(0.15)],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    ),
                    lineWidth: 1
                )
        )
        .padding(.top, 6)
    }

    // MARK: Live burn rate

    private var liveRate: some View {
        HStack(spacing: 8) {
            FlickerIcon(systemName: "flame.fill", live: tps > 0)
                .foregroundStyle(.orange)
                .shadow(color: tps > 0 ? .orange.opacity(0.9) : .clear, radius: tps > 0 ? 9 : 0)
            if tps > 0 {
                Text(BurnFormat.abbrev(Int(tps)))
                    .font(.system(size: 16, weight: .heavy, design: .rounded)).monospacedDigit()
                    .foregroundStyle(
                        LinearGradient(colors: [.yellow, .orange], startPoint: .leading, endPoint: .trailing)
                    )
                    .shadow(color: .orange.opacity(0.8), radius: 6)
                Text("tok/s")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.orange.opacity(0.75))
            } else {
                Text(summary.total > 0 ? "smoldering — no live burn" : "cold — no agents running")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 7)
        .background(Capsule().fill(.ultraThinMaterial))
        .overlay(
            Capsule()
                .stroke(
                    LinearGradient(
                        colors: tps > 0
                            ? [Color.yellow.opacity(0.65), Color.orange.opacity(0.45)]
                            : [Color.orange.opacity(0.15), Color.orange.opacity(0.15)],
                        startPoint: .leading, endPoint: .trailing
                    ),
                    lineWidth: 1.5
                )
        )
        .shadow(color: tps > 0 ? .orange.opacity(0.4) : .clear, radius: tps > 0 ? 12 : 0)
        .animation(.easeInOut(duration: 0.4), value: tps > 0)
    }

    // MARK: Stat row

    private var statRow: some View {
        HStack(spacing: 8) {
            burnStat("\(BurnFormat.abbrev(outputTotal))", "generated", "arrow.up.circle.fill", .pink)
            burnStat(String(format: "$%.3f", summary.totalCost), "spent", "dollarsign.circle.fill", .green)
            burnStat("\(summary.totalTurns)", "turns", "arrow.triangle.2.circlepath", .cyan)
        }
    }

    private func burnStat(_ value: String, _ label: String, _ symbol: String, _ tint: Color) -> some View {
        VStack(spacing: 4) {
            Label(value, systemImage: symbol)
                .font(.system(size: 13, weight: .bold, design: .rounded)).monospacedDigit()
                .labelStyle(.titleAndIcon).foregroundStyle(tint)
                .shadow(color: tint.opacity(0.7), radius: 5)
            Text(label).font(.system(size: 9, weight: .medium)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 12).fill(.ultraThinMaterial))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(
                    LinearGradient(
                        colors: [tint.opacity(0.55), tint.opacity(0.1)],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    ),
                    lineWidth: 1
                )
        )
        .shadow(color: tint.opacity(0.18), radius: 7)
    }

    // MARK: Composition bar (input / output / cache)

    @ViewBuilder
    private var breakdownBar: some View {
        let total = max(1, inputTotal + outputTotal + cacheTotal)
        VStack(alignment: .leading, spacing: 5) {
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 5)
                    .fill(Color.white.opacity(0.06))
                    .frame(height: 10)
                GeometryReader { geo in
                    HStack(spacing: 1.5) {
                        segment(width: geo.size.width * CGFloat(outputTotal) / CGFloat(total), color: .pink)
                        segment(width: geo.size.width * CGFloat(inputTotal) / CGFloat(total), color: .orange)
                        segment(width: geo.size.width * CGFloat(cacheTotal) / CGFloat(total), color: .yellow)
                    }
                }
                .frame(height: 10)
                .clipShape(RoundedRectangle(cornerRadius: 5))
            }
            HStack(spacing: 12) {
                legend("Output", .pink, outputTotal)
                legend("Input", .orange, inputTotal)
                legend("Cache", .yellow, cacheTotal)
                Spacer()
            }
        }
        .animation(.spring(response: 0.6, dampingFraction: 0.8), value: outputTotal)
        .animation(.spring(response: 0.6, dampingFraction: 0.8), value: inputTotal)
        .animation(.spring(response: 0.6, dampingFraction: 0.8), value: cacheTotal)
    }

    private func segment(width: CGFloat, color: Color) -> some View {
        Capsule()
            .fill(LinearGradient(
                colors: [color.opacity(0.95), color.opacity(0.6)],
                startPoint: .leading, endPoint: .trailing
            ))
            .frame(width: max(0, width))
            .shadow(color: color.opacity(0.75), radius: 5)
            .overlay(
                Capsule()
                    .fill(LinearGradient(
                        colors: [Color.white.opacity(0.28), .clear],
                        startPoint: .top, endPoint: .bottom
                    ))
            )
    }

    private func legend(_ name: String, _ color: Color, _ value: Int) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 2)
                .fill(color)
                .frame(width: 8, height: 6)
                .shadow(color: color.opacity(0.6), radius: 2)
            Text(name).font(.system(size: 9)).foregroundStyle(.secondary)
            Text(BurnFormat.abbrev(value)).font(.system(size: 9, weight: .semibold)).monospacedDigit()
                .foregroundStyle(.primary.opacity(0.8))
        }
    }

    // MARK: Leaderboard

    @ViewBuilder
    private var leaderboard: some View {
        if !leaders.isEmpty {
            let top = Double(leaders.first?.totalTokens ?? 1)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 5) {
                    Image(systemName: "trophy.fill")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(
                            LinearGradient(colors: [.yellow, .orange], startPoint: .top, endPoint: .bottom)
                        )
                        .shadow(color: .orange.opacity(0.7), radius: 4)
                    Text("BIGGEST BURNERS")
                        .font(.system(size: 9.5, weight: .bold)).tracking(1.5)
                        .foregroundStyle(.orange.opacity(0.9))
                }
                ForEach(Array(leaders.enumerated()), id: \.element.id) { index, agent in
                    leaderRow(agent,
                              fraction: top > 0 ? Double(agent.totalTokens) / top : 0,
                              isLeader: index == 0)
                }
            }
        } else {
            VStack(spacing: 8) {
                ZStack {
                    Circle()
                        .fill(RadialGradient(
                            colors: [.orange.opacity(0.2), .clear],
                            center: .center, startRadius: 0, endRadius: 30
                        ))
                        .frame(width: 60, height: 60)
                    Image(systemName: "flame")
                        .font(.system(size: 30, weight: .light))
                        .foregroundStyle(
                            LinearGradient(colors: [.orange.opacity(0.8), .red.opacity(0.6)],
                                           startPoint: .top, endPoint: .bottom)
                        )
                        .shadow(color: .orange.opacity(0.4), radius: 8)
                }
                Text("Nothing's burning yet")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(
                        LinearGradient(colors: [.orange.opacity(0.85), .red.opacity(0.65)],
                                       startPoint: .leading, endPoint: .trailing)
                    )
                Text("Launch a fleet — their token spend lights up here.")
                    .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            .padding(.top, 30)
        }
    }

    private func leaderRow(_ agent: AgentRun, fraction: Double, isLeader: Bool) -> some View {
        let barColors: [Color] = isLeader
            ? [.red, .orange, .yellow]
            : [.red.opacity(0.65), .orange.opacity(0.75)]
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                PulsingDot(color: .orange, active: agent.status == .active, size: 6)
                Text(agent.prompt.isEmpty ? agent.folderName : agent.prompt)
                    .font(.system(size: 10.5, weight: .medium)).lineLimit(1)
                    .foregroundStyle(isLeader ? Color.yellow : Color.primary)
                Spacer(minLength: 6)
                Text(BurnFormat.abbrev(agent.totalTokens))
                    .font(.system(size: 10.5, weight: .bold, design: .rounded)).monospacedDigit()
                    .foregroundStyle(.orange)
                    .shadow(color: .orange.opacity(isLeader ? 0.85 : 0.3), radius: isLeader ? 6 : 2)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.07))
                    Capsule()
                        .fill(LinearGradient(colors: barColors, startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(4, geo.size.width * CGFloat(fraction)))
                        .shadow(color: .orange.opacity(isLeader ? 0.85 : 0.4), radius: isLeader ? 7 : 3)
                        .animation(.spring(response: 0.7, dampingFraction: 0.75), value: fraction)
                }
            }
            .frame(height: 7)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(isLeader ? Color.orange.opacity(0.09) : Color.black.opacity(0.2))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(
                    isLeader
                        ? LinearGradient(colors: [.yellow.opacity(0.45), .orange.opacity(0.2)],
                                         startPoint: .topLeading, endPoint: .bottomTrailing)
                        : LinearGradient(colors: [.clear], startPoint: .topLeading, endPoint: .bottomTrailing),
                    lineWidth: 1
                )
        )
    }
}

// MARK: - Formatting

enum BurnFormat {
    /// 1234 → "1.2K", 4_500_000 → "4.50M". Keeps the counter readable as it
    /// rockets upward.
    static func abbrev(_ n: Int) -> String {
        let d = Double(n)
        if n >= 1_000_000 { return String(format: "%.2fM", d / 1_000_000) }
        if n >= 10_000    { return String(format: "%.0fK", d / 1_000) }
        if n >= 1_000     { return String(format: "%.1fK", d / 1_000) }
        return "\(n)"
    }
}
