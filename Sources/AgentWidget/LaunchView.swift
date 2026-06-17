import SwiftUI
import AppKit

/// A model an agent can be launched on. The `flag` is what we pass to
/// `claude --model …`; we use the stable aliases rather than pinned ids so the
/// launch tracks whatever the installed CLI currently maps them to.
enum ModelChoice: String, CaseIterable, Identifiable {
    case opus, sonnet, haiku, fast

    var id: String { rawValue }

    /// CLI flag value; empty means "let the CLI pick its default".
    var flag: String {
        switch self {
        case .opus:   return "opus"
        case .sonnet: return "sonnet"
        case .haiku:  return "haiku"
        case .fast:   return "default"
        }
    }

    var label: String {
        switch self {
        case .opus:   return "Opus 4.8"
        case .sonnet: return "Sonnet 4.6"
        case .haiku:  return "Haiku 4.5"
        case .fast:   return "Default"
        }
    }

    var short: String {
        switch self {
        case .opus:   return "Opus"
        case .sonnet: return "Sonnet"
        case .haiku:  return "Haiku"
        case .fast:   return "Default"
        }
    }

    /// One-line "what's it good for" used in the picker menu.
    var blurb: String {
        switch self {
        case .opus:   return "Deepest reasoning — the heavy lifter"
        case .sonnet: return "Balanced speed & smarts"
        case .haiku:  return "Fast & cheap — quick passes"
        case .fast:   return "Whatever your CLI defaults to"
        }
    }

    var symbol: String {
        switch self {
        case .opus:   return "brain.head.profile"
        case .sonnet: return "scalemass.fill"
        case .haiku:  return "hare.fill"
        case .fast:   return "bolt.fill"
        }
    }

    var tint: Color {
        switch self {
        case .opus:   return Color(red: 0.66, green: 0.45, blue: 0.98)   // violet
        case .sonnet: return Color(red: 0.35, green: 0.62, blue: 0.98)   // blue
        case .haiku:  return Color(red: 0.20, green: 0.85, blue: 0.62)   // green
        case .fast:   return Color(red: 0.62, green: 0.66, blue: 0.74)   // grey
        }
    }
}

/// One worker in the roster the user is assembling.
struct WorkerSpec: Identifiable {
    let id = UUID()
    var model: ModelChoice
}

/// How the launch is shaped: a single agent flying solo, or a coordinated fleet
/// led by a manager that hands out the work.
enum LaunchMode: String, CaseIterable, Identifiable {
    case solo, fleet
    var id: String { rawValue }

    var title: String { self == .solo ? "Solo" : "Fleet" }
    var symbol: String { self == .solo ? "person.fill" : "person.3.fill" }
    var blurb: String {
        self == .solo
            ? "One agent, one mission."
            : "A manager directs a crew of workers."
    }
}

/// Compose-and-launch. Either fire a single agent at a task, or assemble a
/// manager-led fleet: the manager decomposes the mission and hands each worker
/// its own assignment (which files to touch, what "done" means) through a shared
/// `.mission-control/` folder, then reconciles their results. Every agent shows
/// up in the Fleet tab on its own.
struct LaunchView: View {
    @EnvironmentObject var manager: AgentManager
    @EnvironmentObject var settings: Settings
    /// Called right after a successful launch so the shell can flip to Fleet.
    var onLaunched: () -> Void

    @State private var mode: LaunchMode = .fleet
    @State private var task = ""
    @State private var dir = ""
    @State private var soloModel: ModelChoice = .opus
    @State private var managerModel: ModelChoice = .opus
    @State private var workers: [WorkerSpec] = [
        WorkerSpec(model: .sonnet), WorkerSpec(model: .sonnet),
    ]
    @State private var launchedCount: Int?
    @State private var celebrateAt: Date?
    @FocusState private var taskFocused: Bool
    @Namespace private var modeNS

    private var agentCount: Int {
        mode == .solo ? 1 : (1 + workers.count)   // fleet always has its manager
    }
    private var canLaunch: Bool {
        !task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && agentCount > 0
    }

    var body: some View {
        ZStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    modeSwitcher
                    taskSection
                    dirSection
                    terminalSection
                    Group {
                        if mode == .solo { soloSection }
                        else { fleetSection }
                    }
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .move(edge: .bottom)),
                        removal: .opacity))
                    launchButton
                    Color.clear.frame(height: 4)
                }
                .padding(14)
            }
            if let n = launchedCount { launchOverlay(n) }
        }
        .frame(maxHeight: .infinity)
        .onAppear {
            if dir.isEmpty {
                dir = !settings.lastLaunchDir.isEmpty ? settings.lastLaunchDir
                    : (manager.knownDirs.first ?? NSHomeDirectory())
            }
        }
    }

    // MARK: Mode switcher

    private var modeSwitcher: some View {
        HStack(spacing: 6) {
            ForEach(LaunchMode.allCases) { m in
                let selected = mode == m
                Button {
                    withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) { mode = m }
                } label: {
                    VStack(spacing: 3) {
                        HStack(spacing: 6) {
                            Image(systemName: m.symbol).font(.system(size: 12, weight: .bold))
                            Text(m.title).font(.system(size: 13, weight: .bold))
                        }
                        Text(m.blurb).font(.system(size: 9))
                            .foregroundStyle(selected ? .white.opacity(0.85) : .secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .foregroundStyle(selected ? .white : .secondary)
                    .padding(.vertical, 10)
                    .background {
                        if selected {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(LinearGradient(colors: [Color(red: 0.36, green: 0.5, blue: 0.98), .purple],
                                                     startPoint: .topLeading, endPoint: .bottomTrailing))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .stroke(LinearGradient(colors: [.white.opacity(0.35), .clear],
                                                               startPoint: .top, endPoint: .bottom), lineWidth: 1)
                                )
                                .shadow(color: .purple.opacity(0.45), radius: 12, y: 2)
                                .matchedGeometryEffect(id: "modepill", in: modeNS)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .modifier(LaunchGlass(radius: 15, tint: .white, fillOpacity: 0.18, strokeOpacity: 0.08))
    }

    // MARK: Task

    private var taskSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("THE MISSION", "scope")
            ZStack(alignment: .topLeading) {
                if task.isEmpty {
                    Text(mode == .solo
                            ? "Describe the task for your agent…"
                            : "Describe the mission — the manager will split it into assignments…")
                        .font(.system(size: 12)).foregroundStyle(.tertiary)
                        .padding(.horizontal, 5).padding(.vertical, 8)
                }
                TextEditor(text: $task)
                    .font(.system(size: 12))
                    .scrollContentBackground(.hidden)
                    .frame(height: 70)
                    .focused($taskFocused)
            }
            .padding(6)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.ultraThinMaterial))
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.black.opacity(0.18)))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(LinearGradient(colors: [.white.opacity(0.12), .clear],
                                           startPoint: .top, endPoint: .bottom), lineWidth: 1)
            )
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(taskFocused ? Color.accentColor.opacity(0.7) : .white.opacity(0.07), lineWidth: 1))
            .shadow(color: taskFocused ? Color.accentColor.opacity(0.25) : .clear, radius: 10)
            .animation(.easeInOut(duration: 0.25), value: taskFocused)
        }
    }

    // MARK: Working directory

    private var dirSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("WORKING DIRECTORY", "folder")
            HStack(spacing: 6) {
                Image(systemName: "folder.fill").font(.caption).foregroundStyle(.secondary)
                TextField("~/path/to/project", text: $dir)
                    .textFieldStyle(.plain).font(.system(size: 11, design: .monospaced))
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .modifier(LaunchGlass(radius: 10, tint: .white, fillOpacity: 0.18, strokeOpacity: 0.08))

            if !manager.knownDirs.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(manager.knownDirs, id: \.self) { d in
                            Button { withAnimation(.spring(response: 0.34, dampingFraction: 0.8)) { dir = d } } label: {
                                Label((d as NSString).lastPathComponent, systemImage: "clock.arrow.circlepath")
                                    .font(.system(size: 9.5)).labelStyle(.titleAndIcon)
                                    .padding(.horizontal, 9).padding(.vertical, 4)
                                    .background(Capsule().fill(dir == d ? Color.accentColor.opacity(0.2)
                                                                         : Color.white.opacity(0.06)))
                                    .overlay(Capsule().stroke(dir == d ? Color.accentColor.opacity(0.5)
                                                                       : Color.white.opacity(0.08), lineWidth: 1))
                                    .foregroundStyle(dir == d ? .primary : .secondary)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 1)
                }
            }
        }
    }

    // MARK: Launch terminal

    /// Which terminal new agents open in. Only terminals actually installed are
    /// offered, and the choice sticks across launches. Running agents in the
    /// user's real terminal is what gives them the right shell environment — and
    /// therefore lets them start and be tracked.
    private var terminalSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("OPEN IN", "terminal")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(manager.installedTerminals) { t in
                        let on = settings.launchTerminal == t
                        Button { withAnimation(.spring(response: 0.34, dampingFraction: 0.8)) { settings.launchTerminal = t } } label: {
                            Label(t.name, systemImage: "terminal.fill")
                                .font(.system(size: 10, weight: on ? .bold : .regular))
                                .labelStyle(.titleAndIcon)
                                .padding(.horizontal, 10).padding(.vertical, 5)
                                .background(Capsule().fill(on ? Color.accentColor.opacity(0.22)
                                                              : Color.white.opacity(0.06)))
                                .overlay(Capsule().stroke(on ? Color.accentColor.opacity(0.6)
                                                             : Color.white.opacity(0.08), lineWidth: 1))
                                .foregroundStyle(on ? .primary : .secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 1)
            }
        }
    }

    // MARK: Solo

    private var soloSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("MODEL", "cpu")
            ModelGrid(selection: $soloModel)
        }
    }

    // MARK: Fleet

    private var fleetSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            managerSection
            workersSection
            coordinationNote
        }
    }

    private var managerSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                ZStack {
                    Circle().fill(LinearGradient(colors: [.yellow, .orange],
                                                 startPoint: .top, endPoint: .bottom))
                        .frame(width: 30, height: 30)
                        .overlay(Circle().stroke(.white.opacity(0.3), lineWidth: 1))
                        .shadow(color: .yellow.opacity(0.55), radius: 8)
                    Image(systemName: "crown.fill").font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.white)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text("Manager").font(.system(size: 13, weight: .bold))
                    Text("Plans the work, assigns it, reconciles results — never touches code itself.")
                        .font(.system(size: 9)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
            }
            HStack {
                Text("Runs on").font(.system(size: 10.5)).foregroundStyle(.secondary)
                ModelMenu(selection: $managerModel)
                Spacer()
            }
        }
        .padding(13)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(.ultraThinMaterial)
        )
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(LinearGradient(colors: [.yellow.opacity(0.16), .orange.opacity(0.04), .clear],
                                     startPoint: .topLeading, endPoint: .bottomTrailing))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(LinearGradient(colors: [.white.opacity(0.14), .clear],
                                       startPoint: .top, endPoint: .bottom), lineWidth: 1)
        )
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(.yellow.opacity(0.4), lineWidth: 1))
        .shadow(color: .yellow.opacity(0.18), radius: 14)
    }

    private var workersSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                sectionLabel("WORKERS · \(workers.count)", "person.3.fill")
                Spacer()
                stepper
            }
            VStack(spacing: 7) {
                ForEach(Array(workers.enumerated()), id: \.element.id) { idx, worker in
                    workerRow(idx: idx, worker: worker)
                }
            }
        }
    }

    private var stepper: some View {
        HStack(spacing: 8) {
            Button { removeWorker() } label: { Image(systemName: "minus.circle.fill") }
                .buttonStyle(.borderless).foregroundStyle(workers.isEmpty ? .tertiary : .secondary)
                .disabled(workers.isEmpty)
            Text("\(workers.count)").font(.system(size: 12, weight: .bold, design: .rounded))
                .monospacedDigit().frame(minWidth: 16)
                .contentTransition(.numericText())
            Button { addWorker() } label: { Image(systemName: "plus.circle.fill") }
                .buttonStyle(.borderless).foregroundStyle(workers.count >= 8 ? .tertiary : .secondary)
                .disabled(workers.count >= 8)
        }
    }

    private func workerRow(idx: Int, worker: WorkerSpec) -> some View {
        let tint: Color = worker.model.tint
        return HStack(spacing: 9) {
            ZStack {
                Circle().fill(tint.opacity(0.2)).frame(width: 24, height: 24)
                    .overlay(Circle().stroke(tint.opacity(0.4), lineWidth: 1))
                Text("\(idx + 1)").font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(tint)
            }
            ModelMenu(selection: Binding(
                get: { workers[idx].model },
                set: { workers[idx].model = $0 }))
            Spacer()
            Button { withAnimation(.spring(response: 0.36, dampingFraction: 0.8)) { _ = workers.remove(at: idx) } } label: {
                Image(systemName: "xmark.circle.fill").font(.system(size: 12))
            }
            .buttonStyle(.borderless).foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 9).padding(.vertical, 7)
        .modifier(LaunchGlass(radius: 9, tint: tint, fillOpacity: 0, strokeOpacity: 0.28))
        .transition(.asymmetric(insertion: .scale(scale: 0.9).combined(with: .opacity),
                                removal: .scale(scale: 0.9).combined(with: .opacity)))
    }

    /// A tiny diagram + caption that makes the coordination tangible: the manager
    /// writes each worker an assignment file; workers poll, obey, and report back.
    private var coordinationNote: some View {
        HStack(spacing: 11) {
            CoordDiagram(workerCount: workers.count, managerTint: .yellow,
                         animate: manager.popoverVisible)
                .frame(width: 76, height: 46)
            VStack(alignment: .leading, spacing: 2) {
                Text("How they talk").font(.system(size: 10, weight: .bold))
                Text("The manager writes each worker an assignment in `.mission-control/`. Workers poll, obey, and post results back for the manager to reconcile.")
                    .font(.system(size: 9.5)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .modifier(LaunchGlass(radius: 14, tint: .yellow, fillOpacity: 0, strokeOpacity: 0.14))
    }

    // MARK: Launch button

    private var launchLabel: String {
        guard canLaunch else { return "Describe a task to launch" }
        return mode == .solo
            ? "Launch agent"
            : "Launch fleet · \(agentCount) agents"
    }

    private var launchButton: some View {
        Button(action: launch) {
            HStack(spacing: 8) {
                Image(systemName: mode == .solo ? "paperplane.fill" : "sparkles")
                Text(launchLabel).font(.system(size: 13, weight: .bold))
            }
            .frame(maxWidth: .infinity).padding(.vertical, 13)
            .foregroundStyle(.white)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(LinearGradient(colors: canLaunch ? [Color(red: 0.36, green: 0.5, blue: 0.98), .purple]
                                                            : [.gray.opacity(0.35), .gray.opacity(0.25)],
                                         startPoint: .leading, endPoint: .trailing))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(LinearGradient(colors: [.white.opacity(canLaunch ? 0.32 : 0.1), .clear],
                                           startPoint: .top, endPoint: .bottom), lineWidth: 1)
            )
            .shadow(color: canLaunch ? .purple.opacity(0.45) : .clear, radius: 14, y: 3)
        }
        .buttonStyle(.plain).disabled(!canLaunch)
        .animation(.spring(response: 0.4, dampingFraction: 0.8), value: canLaunch)
        .padding(.top, 2)
    }

    private func launchOverlay(_ n: Int) -> some View {
        ZStack {
            Celebration(trigger: celebrateAt)
                .allowsHitTesting(false)
            VStack(spacing: 10) {
                Image(systemName: mode == .solo ? "paperplane.fill" : "sparkles")
                    .font(.system(size: 40))
                    .foregroundStyle(LinearGradient(colors: [.cyan, .purple], startPoint: .top, endPoint: .bottom))
                    .shadow(color: .purple.opacity(0.5), radius: 12)
                Text(n == 1 ? "Agent launched" : "Launched \(n) agents")
                    .font(.system(size: 15, weight: .bold))
                Text(mode == .solo
                        ? "Opening a terminal — watch it light up in Fleet."
                        : "Manager's handing out assignments — watch them light up in Fleet.")
                    .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            .padding(26)
            .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(.ultraThinMaterial))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(LinearGradient(colors: [.white.opacity(0.16), .clear],
                                           startPoint: .top, endPoint: .bottom), lineWidth: 1)
            )
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(.purple.opacity(0.45), lineWidth: 1))
            .shadow(color: .purple.opacity(0.3), radius: 24)
            .transition(.scale(scale: 0.85).combined(with: .opacity))
        }
    }

    // MARK: Helpers

    private func sectionLabel(_ text: String, _ symbol: String) -> some View {
        Label(text, systemImage: symbol)
            .font(.system(size: 9.5, weight: .bold)).foregroundStyle(.secondary)
            .labelStyle(.titleAndIcon)
    }

    private func addWorker() {
        withAnimation(.spring(response: 0.36, dampingFraction: 0.8)) {
            workers.append(WorkerSpec(model: workers.last?.model ?? .sonnet))
        }
    }

    private func removeWorker() {
        guard !workers.isEmpty else { return }
        withAnimation(.spring(response: 0.36, dampingFraction: 0.8)) { _ = workers.removeLast() }
    }

    // MARK: Launch

    private func launch() {
        let mission = task.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !mission.isEmpty else { return }

        let plan: AgentManager.FleetPlan
        switch mode {
        case .solo:
            plan = AgentManager.FleetPlan(
                mission: mission, dir: dir,
                managerModel: nil, workerModels: [soloModel.flag])
        case .fleet:
            plan = AgentManager.FleetPlan(
                mission: mission, dir: dir,
                managerModel: managerModel.flag,
                workerModels: workers.map { $0.model.flag })
        }

        manager.launchFleet(plan)
        settings.lastLaunchDir = dir

        celebrateAt = .now
        withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) { launchedCount = plan.agentCount }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            withAnimation { launchedCount = nil }
            onLaunched()
        }
    }
}

/// The four models as big, tappable cards — the centrepiece of Solo mode. The
/// selected one lifts, glows in its tint, and shows a check.
struct ModelGrid: View {
    @Binding var selection: ModelChoice
    private let cols = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]

    var body: some View {
        LazyVGrid(columns: cols, spacing: 8) {
            ForEach(ModelChoice.allCases) { m in
                let on = m == selection
                Button {
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.75)) { selection = m }
                } label: {
                    HStack(spacing: 9) {
                        ZStack {
                            Circle().fill(m.tint.opacity(on ? 0.32 : 0.16)).frame(width: 30, height: 30)
                                .overlay(Circle().stroke(m.tint.opacity(on ? 0.6 : 0.0), lineWidth: 1))
                            Image(systemName: m.symbol).font(.system(size: 13, weight: .bold))
                                .foregroundStyle(m.tint)
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(m.short).font(.system(size: 12, weight: .bold))
                            Text(m.blurb).font(.system(size: 8.5)).foregroundStyle(.secondary)
                                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.ultraThinMaterial))
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(m.tint.opacity(on ? 0.16 : 0.0)))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(LinearGradient(colors: [.white.opacity(0.12), .clear],
                                                   startPoint: .top, endPoint: .bottom), lineWidth: 1)
                    )
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(m.tint.opacity(on ? 0.7 : 0.15), lineWidth: on ? 1.5 : 1))
                    .shadow(color: on ? m.tint.opacity(0.4) : .clear, radius: 12, y: 2)
                    .scaleEffect(on ? 1.0 : 0.985)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// A small wiring diagram: a crowned manager node feeding assignment lines down
/// to a row of worker dots — a visual echo of the coordination protocol. When
/// `animate` is true, glowing "assignment" pulses travel down each line from the
/// manager to the workers, who flash as each one lands. Gated so it freezes (and
/// stops redrawing) when the popover is hidden.
struct CoordDiagram: View {
    var workerCount: Int
    var managerTint: Color
    var animate: Bool = true

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !animate)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            Canvas { ctx, size in
                let topY: CGFloat = 10
                let botY = size.height - 8
                let mx = size.width / 2
                let n = max(1, workerCount)
                let usable = size.width - 14
                func wx(_ i: Int) -> CGFloat {
                    n == 1 ? mx : 7 + usable * CGFloat(i) / CGFloat(n - 1)
                }
                let mTop = CGPoint(x: mx, y: topY + 4)

                // Connector lines + a glowing pulse travelling down each one.
                for i in 0..<n {
                    let target = CGPoint(x: wx(i), y: botY)
                    var p = Path()
                    p.move(to: mTop)
                    p.addLine(to: target)
                    ctx.stroke(p, with: .color(managerTint.opacity(0.4)),
                               style: StrokeStyle(lineWidth: 1, dash: [2, 2]))

                    // Pulse position 0→1 along the line, staggered per worker.
                    let u = CoordDiagram.frac(t * 0.55 + Double(i) / Double(n))
                    let px = mTop.x + (target.x - mTop.x) * CGFloat(u)
                    let py = mTop.y + (target.y - mTop.y) * CGFloat(u)
                    let fade = sin(u * .pi)            // fade in/out at the ends
                    let pr: CGFloat = 2.4
                    var pc = ctx
                    pc.opacity = fade
                    pc.addFilter(.blur(radius: 1.2))
                    pc.fill(Circle().path(in: CGRect(x: px - pr, y: py - pr, width: pr * 2, height: pr * 2)),
                            with: .color(.white))
                }

                // Worker dots — they brighten as a pulse lands (u near 1).
                for i in 0..<n {
                    let u = CoordDiagram.frac(t * 0.55 + Double(i) / Double(n))
                    let land = max(0, 1 - abs(u - 0.96) / 0.18)   // flash near arrival
                    let r: CGFloat = 3 + 1.4 * land
                    let cx = wx(i)
                    if land > 0.05 {
                        let gr = r * 3
                        var g = ctx
                        g.opacity = land * 0.8
                        g.fill(Circle().path(in: CGRect(x: cx - gr, y: botY - gr, width: gr * 2, height: gr * 2)),
                               with: .radialGradient(Gradient(colors: [managerTint.opacity(0.9), .clear]),
                                                     center: CGPoint(x: cx, y: botY), startRadius: 0, endRadius: gr))
                    }
                    let rect = CGRect(x: cx - r, y: botY - r, width: r * 2, height: r * 2)
                    ctx.fill(Circle().path(in: rect),
                             with: .color(.white.opacity(0.7 + 0.3 * land)))
                }

                // Manager node with a gentle breathing glow.
                let breathe = 0.5 + 0.5 * sin(t * 2.0)
                let mr: CGFloat = 5
                let glowR = mr * (2.4 + 0.8 * breathe)
                var mg = ctx
                mg.opacity = 0.35 + 0.35 * breathe
                mg.fill(Circle().path(in: CGRect(x: mx - glowR, y: topY - glowR, width: glowR * 2, height: glowR * 2)),
                        with: .radialGradient(Gradient(colors: [managerTint.opacity(0.8), .clear]),
                                              center: CGPoint(x: mx, y: topY), startRadius: 0, endRadius: glowR))
                let mrect = CGRect(x: mx - mr, y: topY - mr, width: mr * 2, height: mr * 2)
                ctx.fill(Circle().path(in: mrect), with: .color(managerTint))
            }
        }
    }

    private static func frac(_ x: Double) -> Double { x - floor(x) }
}

/// A compact dropdown for choosing a model, tinted by the model's accent.
struct ModelMenu: View {
    @Binding var selection: ModelChoice

    var body: some View {
        Menu {
            ForEach(ModelChoice.allCases) { m in
                Button {
                    selection = m
                } label: {
                    // A checkmark for the current pick, name + blurb for the rest.
                    if m == selection {
                        Label("\(m.label) — \(m.blurb)", systemImage: "checkmark")
                    } else {
                        Text("\(m.label) — \(m.blurb)")
                    }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Circle().fill(selection.tint).frame(width: 7, height: 7)
                    .shadow(color: selection.tint.opacity(0.7), radius: 3)
                Text(selection.label).font(.system(size: 11, weight: .semibold))
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 8, weight: .bold))
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 9).padding(.vertical, 5)
            .background(Capsule().fill(selection.tint.opacity(0.16)))
            .overlay(Capsule().stroke(selection.tint.opacity(0.45), lineWidth: 1))
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
    }
}

// MARK: - Glass panel treatment

/// Aurora-Glass panel chrome for the Launch tab: translucent material (with an
/// optional darkening fill for input legibility), a hairline white top
/// highlight, and a 1px tinted hairline stroke. File-private so it never
/// collides with the shared primitives Worker 1 owns.
private struct LaunchGlass: ViewModifier {
    var radius: CGFloat
    var tint: Color = .white
    var material: Material = .ultraThinMaterial
    var fillOpacity: Double = 0
    var strokeOpacity: Double = 0.3
    var glow: Double = 0

    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(material))
            .background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Color.black.opacity(fillOpacity)))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(LinearGradient(colors: [.white.opacity(0.13), .clear],
                                           startPoint: .top, endPoint: .bottom), lineWidth: 1)
            )
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(tint.opacity(strokeOpacity), lineWidth: 1)
            )
            .shadow(color: glow > 0 ? tint.opacity(glow) : .clear, radius: glow > 0 ? 14 : 0)
    }
}
