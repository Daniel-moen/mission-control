import SwiftUI
import AppKit

/// One agent in the fleet — now a living tile: a status ring that sweeps while
/// it works, a heartbeat equalizer, a real activity sparkline, an expandable
/// color feed, the plan, an inline todo checklist, and quick controls.
struct AgentCard: View {
    @EnvironmentObject var manager: AgentManager
    @EnvironmentObject var settings: Settings
    @ObservedObject var agent: AgentRun
    @State private var expanded = false
    @State private var showFeed = false
    @State private var showTodos = false
    @State private var confirmDestroy = false
    @State private var reply = ""
    @State private var replyHint: String?
    @State private var didInitFeed = false
    @FocusState private var replyFocused: Bool

    private var canControlTerminal: Bool { agent.terminal?.controllable ?? false }
    private var tint: Color { agent.accent }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            titleRow
            metaRow
            if agent.progress != nil || agent.isLive { progressRow }
            liveBar
            if agent.latestPlan != nil { planRow }
            if showTodos, !agent.todos.isEmpty { todoChecklist }
            if showFeed { feedView }
            controlRow
            replyBox
        }
        .padding(13)
        .background(cardBackground)
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(LinearGradient(
                    colors: [tint.opacity(agent.isLive ? 0.6 : 0.2), tint.opacity(agent.isLive ? 0.22 : 0.08)],
                    startPoint: .top, endPoint: .bottom),
                    lineWidth: agent.isLive ? 1.3 : 1))
        .shadow(color: agent.isLive ? tint.opacity(0.26) : .black.opacity(0.18),
                radius: agent.isLive ? 14 : 7, y: 3)
        .onAppear { if !didInitFeed { showFeed = settings.expandFeeds; didInitFeed = true } }
        .confirmationDialog("Destroy this agent?", isPresented: $confirmDestroy, titleVisibility: .visible) {
            Button("Destroy agent", role: .destructive) { manager.destroy(agent) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Kills the running claude process in \(agent.folderName) and removes it from the monitor.")
        }
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 14)
            .fill(.ultraThinMaterial)
            .overlay(  // state-tinted wash, stronger while live
                RoundedRectangle(cornerRadius: 14)
                    .fill(LinearGradient(colors: [tint.opacity(agent.isLive ? 0.14 : 0.05), .clear],
                                         startPoint: .topLeading, endPoint: .bottomTrailing)))
            .overlay(  // hairline top highlight — the signature glass sheen
                RoundedRectangle(cornerRadius: 14)
                    .stroke(LinearGradient(colors: [.white.opacity(0.16), .clear],
                                           startPoint: .top, endPoint: .center), lineWidth: 1)
                    .blendMode(.plusLighter))
    }

    // MARK: Rows

    private var titleRow: some View {
        HStack(alignment: .top, spacing: 10) {
            StatusRing(progress: agent.progress, color: tint, active: agent.isLive,
                       glyph: agent.status.glyph, size: 30, animate: manager.popoverVisible)
            VStack(alignment: .leading, spacing: 3) {
                Text(agent.prompt.isEmpty ? "(session \(agent.sessionId.prefix(8)))" : agent.prompt)
                    .font(.system(size: 12.5, weight: .semibold))
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                Sparkline(samples: agent.activitySamples(), color: tint)
                    .frame(height: 14).opacity(0.9)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 5) {
                statusBadge
                if agent.isLive {
                    Equalizer(color: tint, active: true, intensity: agent.intensity, bars: 10,
                              animate: manager.popoverVisible)
                        .frame(width: 40, height: 14)
                }
            }
        }
    }

    private var statusBadge: some View {
        Text(agent.status.label.uppercased())
            .font(.system(size: 8.5, weight: .bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 7).padding(.vertical, 2.5)
            .background(Capsule().fill(tint.opacity(0.16)))
            .overlay(Capsule().stroke(tint.opacity(0.35), lineWidth: 0.5))
    }

    private var metaRow: some View {
        HStack(spacing: 8) {
            Label(agent.folderName, systemImage: "folder").lineLimit(1)
            if let term = agent.terminal?.app, !term.isEmpty {
                Label(term, systemImage: "terminal")
            }
            Spacer()
            Label(agent.uptimeLabel, systemImage: "clock")
            Text("· \(agent.lastActiveLabel)").foregroundStyle(.tertiary)
        }
        .font(.system(size: 9.5)).foregroundStyle(.secondary).labelStyle(.titleAndIcon)
    }

    @ViewBuilder
    private var progressRow: some View {
        if let p = agent.progress {
            Button { withAnimation(.spring(response: 0.3)) { showTodos.toggle() } } label: {
                VStack(alignment: .leading, spacing: 3) {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.secondary.opacity(0.18))
                            Capsule()
                                .fill(LinearGradient(colors: Color.gradientPair(tint),
                                                     startPoint: .leading, endPoint: .trailing))
                                .frame(width: max(5, geo.size.width * p))
                                .shadow(color: tint.opacity(0.5), radius: 3)
                        }
                    }
                    .frame(height: 5)
                    HStack(spacing: 4) {
                        Text("Plan · \(agent.completedSteps)/\(agent.totalSteps) steps")
                        Image(systemName: showTodos ? "chevron.up" : "chevron.down").font(.system(size: 7))
                    }
                    .font(.system(size: 9)).foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.plain)
        }
    }

    /// Inline, animated checklist mirroring the agent's TodoWrite plan.
    private var todoChecklist: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(agent.todos) { todo in
                HStack(alignment: .top, spacing: 7) {
                    Image(systemName: icon(for: todo.status))
                        .font(.system(size: 10))
                        .foregroundStyle(todo.status == "completed" ? tint :
                                            (todo.status == "in_progress" ? Color.yellow : Color.secondary))
                    Text(todo.status == "in_progress" && !todo.activeForm.isEmpty ? todo.activeForm : todo.content)
                        .font(.system(size: 10.5))
                        .strikethrough(todo.status == "completed", color: .secondary)
                        .foregroundStyle(todo.status == "completed" ? .secondary : .primary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
    }

    private func icon(for status: String) -> String {
        switch status {
        case "completed":   return "checkmark.circle.fill"
        case "in_progress": return "circle.dotted"
        default:            return "circle"
        }
    }

    private var liveBar: some View {
        Button { withAnimation(.spring(response: 0.3)) { showFeed.toggle() } } label: {
            HStack(spacing: 6) {
                Image(systemName: showFeed ? "chevron.down" : "chevron.right")
                    .font(.system(size: 8, weight: .bold)).foregroundStyle(.white.opacity(0.5))
                Text(latestLine)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(latestColor).lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 9).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 9).fill(Color.black.opacity(0.78)))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(.white.opacity(0.06), lineWidth: 1))
            .animation(.easeInOut(duration: 0.15), value: agent.log.last?.id)
        }
        .buttonStyle(.plain).help("Show recent activity")
    }

    private var feedView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(agent.log.suffix(40)) { line in
                        Text(prefix(line.kind) + line.text)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(color(line.kind))
                            .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                            .id(line.id)
                    }
                }
                .padding(8)
            }
            .frame(height: 140)
            .background(RoundedRectangle(cornerRadius: 9).fill(Color.black.opacity(0.82)))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(.white.opacity(0.06), lineWidth: 1))
            .transition(.opacity.combined(with: .move(edge: .top)))
            .onChange(of: agent.log.last?.id) { id in
                guard let id else { return }
                withAnimation { proxy.scrollTo(id, anchor: .bottom) }
            }
            .onAppear { if let id = agent.log.last?.id { proxy.scrollTo(id, anchor: .bottom) } }
        }
    }

    private var planRow: some View {
        Button { PlanWindowController.shared.show(for: agent) } label: {
            HStack(spacing: 7) {
                Image(systemName: "list.clipboard.fill").font(.system(size: 11)).foregroundStyle(.purple)
                Text(agent.plans.count > 1 ? "Plan ready · \(agent.plans.count) revisions" : "Plan ready")
                    .font(.system(size: 11, weight: .semibold))
                Spacer()
                Image(systemName: "arrow.up.right.square").font(.system(size: 11))
            }
            .foregroundStyle(.purple)
            .padding(.horizontal, 9).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 7)
                .fill(LinearGradient(colors: [.purple.opacity(0.18), .blue.opacity(0.12)],
                                     startPoint: .leading, endPoint: .trailing)))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(.purple.opacity(0.3)))
        }
        .buttonStyle(.plain).help("Open this agent's plan in a pop-out window")
    }

    private var controlRow: some View {
        HStack(spacing: 12) {
            if agent.costUSD > 0 {
                Label(String(format: "$%.4f", agent.costUSD), systemImage: "dollarsign.circle")
                    .font(.system(size: 9.5)).foregroundStyle(.tertiary).labelStyle(.titleAndIcon)
            }
            if agent.totalTokens > 0 {
                Label(BurnFormat.abbrev(agent.totalTokens), systemImage: "flame")
                    .font(.system(size: 9.5))
                    .foregroundStyle(agent.isLive ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.tertiary))
                    .labelStyle(.titleAndIcon)
            }
            Spacer()
            if canControlTerminal {
                ctrlButton("arrow.up.forward.app", help: focusHelp) { manager.focus(agent) }
                ctrlButton(expanded ? "bubble.left.fill" : "bubble.left", help: replyLabel) {
                    withAnimation(.spring(response: 0.3)) { expanded.toggle(); replyFocused = expanded }
                }
            }
            ctrlButton("eye.slash", help: "Remove from monitor (leaves the agent running)") { manager.remove(agent) }
            ctrlButton("xmark.octagon", help: "Destroy — kill this agent's process",
                       color: .red) { confirmDestroy = true }
        }
    }

    private func ctrlButton(_ symbol: String, help: String, color: Color = .secondary, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol) }
            .buttonStyle(.borderless).foregroundStyle(color).help(help)
    }

    // MARK: Reply

    @ViewBuilder
    private var replyBox: some View {
        if expanded && canControlTerminal {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    TextField("Reply to this agent…", text: $reply, axis: .vertical)
                        .textFieldStyle(.roundedBorder).font(.system(size: 11))
                        .lineLimit(1...4).focused($replyFocused).onSubmit { sendReply(reply) }
                    Button { sendReply(reply) } label: { Image(systemName: "paperplane.fill") }
                        .buttonStyle(.borderless)
                        .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                // One-tap presets for the replies you send most.
                HStack(spacing: 5) {
                    ForEach(quickReplies, id: \.0) { label, text in
                        Button { sendReply(text) } label: {
                            Text(label).font(.system(size: 9.5, weight: .medium))
                                .padding(.horizontal, 7).padding(.vertical, 3)
                                .background(Capsule().fill(tint.opacity(0.15)))
                                .foregroundStyle(tint)
                        }
                        .buttonStyle(.plain)
                    }
                }
                if let hint = replyHint {
                    Text(hint).font(.caption2).foregroundStyle(.red)
                } else if agent.terminal?.scriptable == false {
                    Text("Types into the focused \(agent.terminal?.app ?? "terminal") tab via keystrokes.")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
    }

    private var quickReplies: [(String, String)] {
        [("Continue", "continue"), ("Yes", "yes"), ("Approve plan", "1"),
         ("Run tests", "run the tests"), ("Stop", "stop")]
    }

    private func sendReply(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        switch manager.send(text, to: agent) {
        case .sent:
            reply = ""; replyHint = nil; replyFocused = true
        case .needsAccessibility:
            replyHint = "Grant Accessibility (System Settings ▸ Privacy & Security ▸ Accessibility) to type into this terminal, then try again."
        case .failed:
            replyHint = "Couldn't reach this agent's terminal tab."
        }
    }

    // MARK: Helpers

    private var latestLine: String {
        if let last = agent.log.last { return prefix(last.kind) + last.text }
        return agent.activity
    }
    private var latestColor: Color { agent.log.last.map { color($0.kind) } ?? .white }

    private var focusHelp: String {
        let app = agent.terminal?.app ?? ""
        return app.isEmpty ? "Bring this agent's terminal to the front" : "Switch to this agent's \(app) tab"
    }
    private var replyLabel: String {
        let app = agent.terminal?.app ?? ""
        return app.isEmpty ? "Reply" : "Reply in \(app)"
    }

    private func prefix(_ kind: LogLine.Kind) -> String {
        switch kind {
        case .command: return "$ "
        case .text:    return "💬 "
        case .tool:    return "⚙ "
        case .result:  return "→ "
        case .status:  return "• "
        }
    }
    private func color(_ kind: LogLine.Kind) -> Color {
        switch kind {
        case .command: return .green
        case .text:    return .white
        case .tool:    return .cyan
        case .result:  return .gray
        case .status:  return .yellow
        }
    }
}
