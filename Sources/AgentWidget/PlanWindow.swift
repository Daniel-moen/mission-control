import SwiftUI
import AppKit

/// Opens (and reuses) a standalone, resizable window that renders an agent's
/// captured plan as formatted markdown. A real window rather than a nested
/// popover so it survives the menu-bar popover closing and can sit beside your
/// work while the agent executes the plan.
final class PlanWindowController {
    static let shared = PlanWindowController()
    private init() {}

    private var windows: [String: NSWindow] = [:]

    func show(for agent: AgentRun) {
        if let existing = windows[agent.sessionId] {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 680),
            styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.title = "Plan · \(agent.folderName)"
        window.isReleasedWhenClosed = false
        window.center()
        window.contentViewController = NSHostingController(rootView: PlanView(agent: agent))

        // Drop our handle when the user closes it so reopening makes a fresh one.
        let token = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in
            self?.windows[agent.sessionId] = nil
        }
        objc_setAssociatedObject(window, Unmanaged.passUnretained(window).toOpaque(), token, .OBJC_ASSOCIATION_RETAIN)

        windows[agent.sessionId] = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func close(_ sessionId: String) {
        windows[sessionId]?.close()
    }
}

// MARK: - Plan view

struct PlanView: View {
    @ObservedObject var agent: AgentRun
    @State private var revision: Int = -1     // -1 → follow the latest

    private var plan: CapturedPlan? {
        guard !agent.plans.isEmpty else { return nil }
        let idx = revision < 0 ? agent.plans.count - 1 : min(revision, agent.plans.count - 1)
        return agent.plans[idx]
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if let plan {
                ScrollView {
                    PlanMarkdown(plan.text)
                        .padding(18)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                footer(plan)
            } else {
                Spacer()
                Text("This agent hasn't proposed a plan yet.")
                    .foregroundStyle(.secondary)
                Spacer()
            }
        }
        .frame(minWidth: 420, minHeight: 360)
        .background(Color(NSColor.textBackgroundColor))
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "list.clipboard.fill")
                .font(.system(size: 18))
                .foregroundStyle(LinearGradient(colors: [.purple, .blue],
                                                startPoint: .top, endPoint: .bottom))
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.prompt.isEmpty ? "Proposed plan" : agent.prompt)
                    .font(.headline).lineLimit(2)
                HStack(spacing: 6) {
                    Label(agent.folderName, systemImage: "folder")
                    Text("· \(agent.status.label)")
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if agent.plans.count > 1 { revisionPicker }
        }
        .padding(14)
    }

    /// When an agent revises its plan, let you flip between revisions; the most
    /// recent is labelled so you always know which is live.
    private var revisionPicker: some View {
        Picker("", selection: Binding(
            get: { revision < 0 ? agent.plans.count - 1 : revision },
            set: { revision = $0 })) {
            ForEach(Array(agent.plans.enumerated()), id: \.offset) { i, _ in
                Text(i == agent.plans.count - 1 ? "Latest (rev \(i + 1))" : "rev \(i + 1)").tag(i)
            }
        }
        .labelsHidden()
        .frame(width: 140)
    }

    private func footer(_ plan: CapturedPlan) -> some View {
        HStack {
            Text("Captured \(plan.at.formatted(date: .omitted, time: .standard))")
                .font(.caption2).foregroundStyle(.tertiary)
            Spacer()
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(plan.text, forType: .string)
            } label: {
                Label("Copy markdown", systemImage: "doc.on.doc")
            }
            .controlSize(.small)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }
}

// MARK: - Lightweight markdown renderer

/// A small block-level markdown renderer good enough for agent plans: headings,
/// bullet and numbered lists, fenced code, and inline emphasis/code. SwiftUI's
/// built-in markdown only handles inline syntax, so we split into blocks and
/// style each, leaning on `Text(.init:)` for the inline pass within a line.
struct PlanMarkdown: View {
    let blocks: [Block]
    init(_ source: String) { blocks = PlanMarkdown.parse(source) }

    enum Block {
        case heading(level: Int, text: String)
        case bullet(text: String, indent: Int)
        case numbered(number: String, text: String)
        case code(String)
        case paragraph(String)
        case rule
        case blank
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case let .heading(level, text):
                    Text(inline(text))
                        .font(.system(size: headingSize(level), weight: .bold))
                        .padding(.top, level <= 2 ? 8 : 4)
                case let .bullet(text, indent):
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text("•").foregroundStyle(.purple)
                        Text(inline(text)).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.leading, CGFloat(indent) * 16)
                case let .numbered(number, text):
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text(number).foregroundStyle(.purple).monospacedDigit()
                        Text(inline(text)).fixedSize(horizontal: false, vertical: true)
                    }
                case let .code(text):
                    Text(text)
                        .font(.system(size: 11.5, design: .monospaced))
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.12)))
                case let .paragraph(text):
                    Text(inline(text)).fixedSize(horizontal: false, vertical: true)
                case .rule:
                    Divider().padding(.vertical, 4)
                case .blank:
                    Spacer().frame(height: 2)
                }
            }
        }
    }

    private func headingSize(_ level: Int) -> CGFloat {
        switch level { case 1: return 20; case 2: return 16; case 3: return 14; default: return 12.5 }
    }

    /// Inline markdown (bold/italic/`code`) via SwiftUI's own parser; falls back
    /// to plain text if a line happens not to be valid inline markdown.
    private func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s)) ?? AttributedString(s)
    }

    // MARK: Parsing

    static func parse(_ source: String) -> [Block] {
        var blocks: [Block] = []
        var inCode = false
        var codeBuf: [String] = []

        for raw in source.components(separatedBy: "\n") {
            let line = raw
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") {
                if inCode { blocks.append(.code(codeBuf.joined(separator: "\n"))); codeBuf = [] }
                inCode.toggle()
                continue
            }
            if inCode { codeBuf.append(line); continue }

            if trimmed.isEmpty { blocks.append(.blank); continue }
            if trimmed == "---" || trimmed == "***" || trimmed == "___" { blocks.append(.rule); continue }

            if trimmed.hasPrefix("#") {
                let hashes = trimmed.prefix { $0 == "#" }.count
                let text = trimmed.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)
                blocks.append(.heading(level: min(hashes, 4), text: text))
                continue
            }

            // Bullet list (-, *, +), tracking nesting by leading spaces.
            if let m = trimmed.range(of: #"^[-*+]\s+"#, options: .regularExpression) {
                let indent = line.prefix { $0 == " " }.count / 2
                blocks.append(.bullet(text: String(trimmed[m.upperBound...]), indent: indent))
                continue
            }

            // Numbered list "1. text" / "1) text".
            if let m = trimmed.range(of: #"^\d+[.)]\s+"#, options: .regularExpression) {
                let num = trimmed[..<m.upperBound].trimmingCharacters(in: .whitespaces)
                blocks.append(.numbered(number: num, text: String(trimmed[m.upperBound...])))
                continue
            }

            blocks.append(.paragraph(trimmed))
        }
        if inCode, !codeBuf.isEmpty { blocks.append(.code(codeBuf.joined(separator: "\n"))) }
        return blocks
    }
}
