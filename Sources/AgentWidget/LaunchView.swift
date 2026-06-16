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

/// Compose-and-launch a fleet: describe a task once, give it a manager and any
/// number of workers each on the model you choose, and fire them all into their
/// own terminals. They surface in the Fleet tab on their own.
struct LaunchView: View {
    @EnvironmentObject var manager: AgentManager
    @EnvironmentObject var settings: Settings
    /// Called right after a successful launch so the shell can flip to Fleet.
    var onLaunched: () -> Void

    @State private var task = ""
    @State private var dir = ""
    @State private var managerEnabled = true
    @State private var managerModel: ModelChoice = .opus
    @State private var workers: [WorkerSpec] = [
        WorkerSpec(model: .sonnet), WorkerSpec(model: .sonnet),
    ]
    @State private var launchedCount: Int?
    @FocusState private var taskFocused: Bool

    private var agentCount: Int { (managerEnabled ? 1 : 0) + workers.count }
    private var canLaunch: Bool {
        !task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && agentCount > 0
    }

    var body: some View {
        ZStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    taskSection
                    dirSection
                    managerSection
                    workersSection
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

    // MARK: Task

    private var taskSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("THE MISSION", "scope")
            ZStack(alignment: .topLeading) {
                if task.isEmpty {
                    Text("Describe the task every agent should tackle…")
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
            .background(RoundedRectangle(cornerRadius: 9).fill(Color.black.opacity(0.25)))
            .overlay(RoundedRectangle(cornerRadius: 9)
                .stroke(taskFocused ? Color.accentColor.opacity(0.6) : .white.opacity(0.08), lineWidth: 1))
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
            .padding(.horizontal, 9).padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.25)))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.white.opacity(0.08)))

            if !manager.knownDirs.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(manager.knownDirs, id: \.self) { d in
                            Button { dir = d } label: {
                                Label((d as NSString).lastPathComponent, systemImage: "clock.arrow.circlepath")
                                    .font(.system(size: 9.5)).labelStyle(.titleAndIcon)
                                    .padding(.horizontal, 8).padding(.vertical, 3)
                                    .background(Capsule().fill(Color.secondary.opacity(0.14)))
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    // MARK: Manager

    private var managerSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: $managerEnabled.animation(.spring(response: 0.3))) {
                HStack(spacing: 7) {
                    Image(systemName: "crown.fill").font(.system(size: 11)).foregroundStyle(.yellow)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Manager agent").font(.system(size: 12, weight: .semibold))
                        Text("Workers wait for & obey its orders (via .mission-control)")
                            .font(.system(size: 9)).foregroundStyle(.secondary)
                    }
                }
            }
            .toggleStyle(.switch).tint(.yellow)

            if managerEnabled {
                HStack {
                    Text("Runs on").font(.system(size: 10.5)).foregroundStyle(.secondary)
                    ModelMenu(selection: $managerModel)
                    Spacer()
                }
            }
        }
        .padding(11)
        .background(RoundedRectangle(cornerRadius: 11)
            .fill(LinearGradient(colors: [.yellow.opacity(managerEnabled ? 0.12 : 0.04), .clear],
                                 startPoint: .topLeading, endPoint: .bottomTrailing)))
        .overlay(RoundedRectangle(cornerRadius: 11)
            .stroke(.yellow.opacity(managerEnabled ? 0.35 : 0.12), lineWidth: 1))
    }

    // MARK: Workers

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
            Button { addWorker() } label: { Image(systemName: "plus.circle.fill") }
                .buttonStyle(.borderless).foregroundStyle(workers.count >= 8 ? .tertiary : .secondary)
                .disabled(workers.count >= 8)
        }
    }

    private func workerRow(idx: Int, worker: WorkerSpec) -> some View {
        HStack(spacing: 9) {
            ZStack {
                Circle().fill(worker.model.tint.opacity(0.18)).frame(width: 24, height: 24)
                Text("\(idx + 1)").font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundStyle(worker.model.tint)
            }
            ModelMenu(selection: Binding(
                get: { workers[idx].model },
                set: { workers[idx].model = $0 }))
            Spacer()
            Button { workers.remove(at: idx) } label: {
                Image(systemName: "xmark.circle.fill").font(.system(size: 12))
            }
            .buttonStyle(.borderless).foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 9).padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 9).fill(.ultraThinMaterial))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(worker.model.tint.opacity(0.25), lineWidth: 1))
        .transition(.asymmetric(insertion: .scale(scale: 0.9).combined(with: .opacity),
                                removal: .scale(scale: 0.9).combined(with: .opacity)))
    }

    // MARK: Launch button

    private var launchButton: some View {
        Button(action: launch) {
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                Text(canLaunch ? "Launch \(agentCount) agent\(agentCount == 1 ? "" : "s")" : "Describe a task to launch")
                    .font(.system(size: 13, weight: .bold))
            }
            .frame(maxWidth: .infinity).padding(.vertical, 11)
            .foregroundStyle(.white)
            .background(
                RoundedRectangle(cornerRadius: 11)
                    .fill(LinearGradient(colors: canLaunch ? [Color(red: 0.36, green: 0.5, blue: 0.98), .purple]
                                                            : [.gray.opacity(0.4), .gray.opacity(0.3)],
                                         startPoint: .leading, endPoint: .trailing)))
            .shadow(color: canLaunch ? .purple.opacity(0.4) : .clear, radius: 10, y: 3)
        }
        .buttonStyle(.plain).disabled(!canLaunch)
        .padding(.top, 2)
    }

    private func launchOverlay(_ n: Int) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "sparkles")
                .font(.system(size: 40))
                .foregroundStyle(LinearGradient(colors: [.cyan, .purple], startPoint: .top, endPoint: .bottom))
            Text("Launched \(n) agent\(n == 1 ? "" : "s")")
                .font(.system(size: 15, weight: .bold))
            Text("Opening terminals — watch them light up in Fleet.")
                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .padding(26)
        .background(RoundedRectangle(cornerRadius: 16).fill(.ultraThinMaterial))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.purple.opacity(0.4)))
        .shadow(radius: 20)
        .transition(.scale(scale: 0.85).combined(with: .opacity))
    }

    // MARK: Helpers

    private func sectionLabel(_ text: String, _ symbol: String) -> some View {
        Label(text, systemImage: symbol)
            .font(.system(size: 9.5, weight: .bold)).foregroundStyle(.secondary)
            .labelStyle(.titleAndIcon)
    }

    private func addWorker() {
        withAnimation(.spring(response: 0.3)) {
            workers.append(WorkerSpec(model: workers.last?.model ?? .sonnet))
        }
    }

    private func removeWorker() {
        guard !workers.isEmpty else { return }
        withAnimation(.spring(response: 0.3)) { _ = workers.removeLast() }
    }

    // MARK: Launch

    private func launch() {
        let mission = task.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !mission.isEmpty else { return }

        let plan = AgentManager.FleetPlan(
            mission: mission,
            dir: dir,
            managerModel: managerEnabled ? managerModel.flag : nil,
            workerModels: workers.map { $0.model.flag })

        manager.launchFleet(plan)
        settings.lastLaunchDir = dir

        withAnimation(.spring(response: 0.4)) { launchedCount = plan.agentCount }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            withAnimation { launchedCount = nil }
            onLaunched()
        }
    }
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
                Text(selection.label).font(.system(size: 11, weight: .semibold))
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 8, weight: .bold))
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(Capsule().fill(selection.tint.opacity(0.16)))
            .overlay(Capsule().stroke(selection.tint.opacity(0.4), lineWidth: 1))
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
    }
}
