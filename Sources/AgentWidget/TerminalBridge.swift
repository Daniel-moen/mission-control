import Foundation
import AppKit
import CoreGraphics
import ApplicationServices

/// Where an agent's `claude` process is running: its controlling TTY and the
/// terminal app that owns it. Discovered by walking the process tree.
struct TerminalInfo: Equatable {
    var tty: String          // e.g. "/dev/ttys000" ("" if unknown)
    var app: String          // "iTerm2" | "Terminal" | "WezTerm" | "Ghostty" | … | ""
    var bundlePath: String   // owning app's .app bundle ("" if not derivable)

    /// We can focus / reply if we know which app it is or at least its bundle.
    var controllable: Bool { !app.isEmpty || !bundlePath.isEmpty }
    /// Scriptable terminals don't need Accessibility to send a reply.
    var scriptable: Bool { app == "iTerm2" || app == "Terminal" || app == "WezTerm" }
}

/// Focuses terminals and types replies into them across the common macOS
/// terminals. Scriptable apps (iTerm2, Terminal, WezTerm) target the exact
/// tab/pane by TTY; everything else falls back to synthesized keystrokes,
/// which needs Accessibility permission and types into the focused tab.
final class TerminalBridge {
    private let home = NSHomeDirectory()

    // MARK: Discovery

    /// Map of resolved working directory → terminal info for every running
    /// `claude` process. One scan feeds both liveness and terminal targeting.
    func scan() -> [String: TerminalInfo] {
        let script = #"""
        for p in $(ps -axww -o pid=,command= | awk '$2 ~ /(^|\/)claude$/ {print $1}'); do
          cwd=$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
          [ -z "$cwd" ] && continue
          tty=$(ps -o tty= -p "$p" | tr -d ' ')
          app=""; appcmd=""; cur=$p; i=0
          while [ $i -lt 10 ]; do
            ppid=$(ps -o ppid= -p "$cur" | tr -d ' ')
            { [ -z "$ppid" ] || [ "$ppid" = "1" ] || [ "$ppid" = "0" ]; } && break
            cmd=$(ps -o command= -p "$ppid")
            case "$cmd" in
              *iTerm.app*)     app="iTerm2";    appcmd="$cmd"; break;;
              *Terminal.app*)  app="Terminal";  appcmd="$cmd"; break;;
              *WezTerm*|*wezterm*) app="WezTerm"; appcmd="$cmd"; break;;
              *Ghostty*)       app="Ghostty";   appcmd="$cmd"; break;;
              *Alacritty*|*alacritty*) app="Alacritty"; appcmd="$cmd"; break;;
              *kitty*)         app="kitty";     appcmd="$cmd"; break;;
              *Hyper.app*)     app="Hyper";     appcmd="$cmd"; break;;
              *.app/Contents/MacOS/*) appcmd="$cmd"; break;;
            esac
            cur=$ppid; i=$((i+1))
          done
          printf '%s\t%s\t%s\t%s\n' "$cwd" "$tty" "$app" "$appcmd"
        done
        """#
        let out = runShell(script)
        var result: [String: TerminalInfo] = [:]
        for line in out.split(separator: "\n") {
            let parts = line.components(separatedBy: "\t")
            guard parts.count >= 3, !parts[0].isEmpty else { continue }
            let cwd = resolved(parts[0])
            let tty = parts[1].isEmpty ? "" : "/dev/\(parts[1])"
            let app = parts[2]
            let appcmd = parts.count >= 4 ? parts[3] : ""
            result[cwd] = TerminalInfo(tty: tty, app: app, bundlePath: bundle(fromCommand: appcmd))
        }
        return result
    }

    /// `/path/Foo.app/Contents/MacOS/foo …` → `/path/Foo.app`
    private func bundle(fromCommand cmd: String) -> String {
        guard let r = cmd.range(of: ".app/") else {
            return cmd.hasSuffix(".app") ? cmd : ""
        }
        return String(cmd[cmd.startIndex..<r.lowerBound]) + ".app"
    }

    // MARK: Focus

    func focus(_ info: TerminalInfo) {
        switch info.app {
        case "iTerm2":   _ = osascript(iTermFocusScript, [info.tty])
        case "Terminal": _ = osascript(terminalFocusScript, [info.tty])
        case "WezTerm":  focusWezTerm(info)
        default:         activateBundle(info)   // best effort for the rest
        }
    }

    // MARK: Reply

    /// Type `text` into the agent's session and submit it. Returns a result the
    /// UI can act on (success, or "needs Accessibility" for generic terminals).
    @discardableResult
    func send(_ text: String, to info: TerminalInfo) -> SendResult {
        let msg = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !msg.isEmpty else { return .failed }
        switch info.app {
        case "iTerm2":
            return osascript(iTermSendScript, [info.tty, msg])?.contains("ok") == true ? .sent : .failed
        case "Terminal":
            return osascript(terminalSendScript, [info.tty, msg])?.contains("ok") == true ? .sent : .failed
        case "WezTerm":
            return sendWezTerm(msg, info: info) ? .sent : .failed
        default:
            return sendViaKeystrokes(msg, info: info)
        }
    }

    enum SendResult { case sent, failed, needsAccessibility }

    // MARK: Launch

    /// Open a brand-new Terminal.app window and run `command` in it (a fresh
    /// login shell, so the user's PATH — and therefore `claude` — is available).
    /// Returns true if AppleScript reported success. Used by the Launch tab to
    /// spin up agents; they then show up in the fleet on their own.
    @discardableResult
    func launchInTerminal(command: String) -> Bool {
        osascript(terminalLaunchScript, [command])?.contains("ok") == true
    }

    /// Wrap a shell command so a single token is safe to pass through
    /// AppleScript → `/bin/sh`. POSIX single-quoting handles everything.
    static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private let terminalLaunchScript = """
    on run argv
      tell application "Terminal"
        activate
        do script (item 1 of argv)
      end tell
      return "ok"
    end run
    """

    // MARK: AppleScript backends (iTerm2 / Terminal)

    private let iTermFocusScript = """
    on run argv
      set theTty to item 1 of argv
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if (tty of s) is theTty then
                select s
                tell t to select
                set index of w to 1
                activate
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
      end tell
      return "notfound"
    end run
    """

    private let iTermSendScript = """
    on run argv
      set theTty to item 1 of argv
      set theMsg to item 2 of argv
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if (tty of s) is theTty then
                tell s to write text theMsg
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
      end tell
      return "notfound"
    end run
    """

    private let terminalFocusScript = """
    on run argv
      set theTty to item 1 of argv
      tell application "Terminal"
        repeat with w in windows
          repeat with t in tabs of w
            if (tty of t) is theTty then
              set selected tab of w to t
              set index of w to 1
              activate
              return "ok"
            end if
          end repeat
        end repeat
      end tell
      return "notfound"
    end run
    """

    private let terminalSendScript = """
    on run argv
      set theTty to item 1 of argv
      set theMsg to item 2 of argv
      tell application "Terminal"
        repeat with w in windows
          repeat with t in tabs of w
            if (tty of t) is theTty then
              do script theMsg in t
              return "ok"
            end if
          end repeat
        end repeat
      end tell
      return "notfound"
    end run
    """

    @discardableResult
    private func osascript(_ script: String, _ args: [String]) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", script] + args   // args bind to the `run` handler's argv
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        let d = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        return String(data: d, encoding: .utf8)
    }

    // MARK: Generic backend (synthesized keystrokes)

    private func sendViaKeystrokes(_ text: String, info: TerminalInfo) -> SendResult {
        guard accessibilityTrusted(prompt: true) else { return .needsAccessibility }
        activateBundle(info)
        // Let the app come forward before typing into it.
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.typeUnicode(text)
            self?.pressReturn()
        }
        return .sent
    }

    private func accessibilityTrusted(prompt: Bool) -> Bool {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
    }

    private func typeUnicode(_ text: String) {
        let src = CGEventSource(stateID: .combinedSessionState)
        for scalar in text.unicodeScalars {
            var utf16 = Array(String(scalar).utf16)
            if let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) {
                down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
                down.post(tap: .cghidEventTap)
            }
            if let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) {
                up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
                up.post(tap: .cghidEventTap)
            }
            usleep(1500)
        }
    }

    private func pressReturn() {
        let src = CGEventSource(stateID: .combinedSessionState)
        CGEvent(keyboardEventSource: src, virtualKey: 0x24, keyDown: true)?.post(tap: .cghidEventTap)
        CGEvent(keyboardEventSource: src, virtualKey: 0x24, keyDown: false)?.post(tap: .cghidEventTap)
    }

    private func activateBundle(_ info: TerminalInfo) {
        guard !info.bundlePath.isEmpty else { return }
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: info.bundlePath),
                                           configuration: NSWorkspace.OpenConfiguration())
    }

    // MARK: WezTerm backend (CLI)

    private func focusWezTerm(_ info: TerminalInfo) {
        guard let id = weztermPaneId(forTty: info.tty) else { activateBundle(info); return }
        weztermCLI(["activate-pane", "--pane-id", "\(id)"])
        if let bundle = weztermAppBundle {
            NSWorkspace.shared.openApplication(at: bundle, configuration: NSWorkspace.OpenConfiguration())
        }
    }

    private func sendWezTerm(_ text: String, info: TerminalInfo) -> Bool {
        guard let id = weztermPaneId(forTty: info.tty) else { return false }
        weztermCLI(["send-text", "--no-paste", "--pane-id", "\(id)", text])
        weztermCLI(["send-text", "--no-paste", "--pane-id", "\(id)", "\r"])
        return true
    }

    private func weztermPaneId(forTty tty: String) -> Int? {
        guard !tty.isEmpty,
              let json = weztermCLI(["list", "--format", "json"]),
              let data = json.data(using: .utf8),
              let panes = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
        for pane in panes where (pane["tty_name"] as? String) == tty {
            if let id = pane["pane_id"] as? Int { return id }
        }
        return nil
    }

    private lazy var weztermPath: String? = {
        let candidates = [
            "/opt/homebrew/bin/wezterm", "/usr/local/bin/wezterm",
            "/Applications/WezTerm.app/Contents/MacOS/wezterm",
            "\(home)/Applications/WezTerm.app/Contents/MacOS/wezterm",
        ]
        if let f = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) { return f }
        if let items = try? FileManager.default.contentsOfDirectory(atPath: "\(home)/Downloads") {
            for item in items where item.hasPrefix("WezTerm") {
                let p = "\(home)/Downloads/\(item)/WezTerm.app/Contents/MacOS/wezterm"
                if FileManager.default.isExecutableFile(atPath: p) { return p }
            }
        }
        return nil
    }()

    private var weztermAppBundle: URL? {
        guard let p = weztermPath else { return nil }
        var url = URL(fileURLWithPath: p)
        for _ in 0..<3 { url.deleteLastPathComponent() }
        return url.pathExtension == "app" ? url : nil
    }

    private func weztermSocket() -> String? {
        if let s = ProcessInfo.processInfo.environment["WEZTERM_UNIX_SOCKET"] { return s }
        let dir = "\(home)/.local/share/wezterm"
        guard let items = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return nil }
        return items.filter { $0.hasPrefix("gui-sock-") }.map { "\(dir)/\($0)" }.sorted {
            let a = (try? FileManager.default.attributesOfItem(atPath: $0)[.modificationDate] as? Date) ?? nil
            let b = (try? FileManager.default.attributesOfItem(atPath: $1)[.modificationDate] as? Date) ?? nil
            return (a ?? .distantPast) > (b ?? .distantPast)
        }.first
    }

    @discardableResult
    private func weztermCLI(_ args: [String]) -> String? {
        guard let wez = weztermPath else { return nil }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: wez)
        p.arguments = ["cli"] + args
        var env = ProcessInfo.processInfo.environment
        if let sock = weztermSocket() { env["WEZTERM_UNIX_SOCKET"] = sock }
        p.environment = env
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { return nil }
        return String(data: data, encoding: .utf8)
    }

    // MARK: Shell helper

    @discardableResult
    func runShell(_ script: String, env extra: [String: String] = [:]) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", script]
        var e = ProcessInfo.processInfo.environment
        for (k, v) in extra { e[k] = v }
        p.environment = e
        let out = Pipe(); p.standardOutput = out; p.standardError = Pipe()
        do { try p.run() } catch { return "" }
        let d = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: d, encoding: .utf8) ?? ""
    }

    private func resolved(_ path: String) -> String {
        (path as NSString).resolvingSymlinksInPath
    }
}
