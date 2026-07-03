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
    /// Returns nil when the scan itself failed (shell couldn't run, `ps`
    /// errored, …) — callers must treat that as "unknown", NOT as "no agents",
    /// or one hiccup under load marks every live agent dead at once.
    func scan() -> [String: TerminalInfo]? {
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
        echo '__MC_SCAN_OK__'
        """#
        let out = runShell(script)
        // No sentinel ⇒ the script never ran to completion — report failure
        // rather than an (indistinguishable) empty fleet.
        guard out.contains("__MC_SCAN_OK__") else { return nil }
        var result: [String: TerminalInfo] = [:]
        for line in out.split(separator: "\n") where line != "__MC_SCAN_OK__" {
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

    // MARK: Screen mirror

    /// The visible contents of the agent's terminal tab/pane — literally what
    /// you'd see standing at the Mac, including the claude TUI, its prompt and
    /// any permission dialog. Only scriptable terminals can be read (iTerm2 /
    /// Terminal.app by TTY via AppleScript, WezTerm via its CLI); returns nil
    /// for the rest.
    func screenText(of info: TerminalInfo) -> String? {
        guard !info.tty.isEmpty else { return nil }
        switch info.app {
        case "iTerm2":   return osascript(iTermScreenScript, [info.tty])
        case "Terminal": return osascript(terminalScreenScript, [info.tty])
        case "WezTerm":
            guard let id = weztermPaneId(forTty: info.tty) else { return nil }
            return weztermCLI(["get-text", "--pane-id", "\(id)"])
        default:
            return nil
        }
    }

    private let iTermScreenScript = """
    on run argv
      set theTty to item 1 of argv
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if (tty of s) is theTty then
                return contents of s
              end if
            end repeat
          end repeat
        end repeat
      end tell
      return ""
    end run
    """

    private let terminalScreenScript = """
    on run argv
      set theTty to item 1 of argv
      tell application "Terminal"
        repeat with w in windows
          repeat with t in tabs of w
            if (tty of t) is theTty then
              return contents of t
            end if
          end repeat
        end repeat
      end tell
      return ""
    end run
    """

    // MARK: Launch

    /// A terminal emulator the launcher can open a fresh agent session in.
    /// Detection and launching are generic — apps are found by bundle id through
    /// LaunchServices, never by hardcoded paths — so this works on any machine
    /// and any install location.
    enum LaunchTerminal: String, CaseIterable, Identifiable {
        case terminal, iterm2, wezterm, ghostty, kitty, alacritty

        var id: String { rawValue }

        var name: String {
            switch self {
            case .terminal:  return "Terminal"
            case .iterm2:    return "iTerm2"
            case .wezterm:   return "WezTerm"
            case .ghostty:   return "Ghostty"
            case .kitty:     return "kitty"
            case .alacritty: return "Alacritty"
            }
        }

        /// LaunchServices bundle identifier — how we both detect and target it.
        var bundleID: String {
            switch self {
            case .terminal:  return "com.apple.Terminal"
            case .iterm2:    return "com.googlecode.iterm2"
            case .wezterm:   return "com.github.wez.wezterm"
            case .ghostty:   return "com.mitchellh.ghostty"
            case .kitty:     return "net.kovidgoyal.kitty"
            case .alacritty: return "org.alacritty"
            }
        }
    }

    /// The terminals actually installed on this machine, in menu order. Empty
    /// never happens in practice — Terminal.app ships with macOS.
    func installedTerminals() -> [LaunchTerminal] {
        LaunchTerminal.allCases.filter { appURL(for: $0) != nil }
    }

    private func appURL(for t: LaunchTerminal) -> URL? {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: t.bundleID)
    }

    /// Open a brand-new window of `terminal` and run `command` in it, inside a
    /// fresh login shell so the user's PATH — and therefore `claude` — resolves
    /// exactly as it does when they run it by hand. Launching into the wrong shell
    /// environment is why an agent could silently fail to start and so never show
    /// up in the fleet. Returns true if the launch was dispatched.
    @discardableResult
    func launch(command: String, in terminal: LaunchTerminal) -> Bool {
        switch terminal {
        case .terminal:
            return osascript(terminalLaunchScript, [command])?.contains("ok") == true
        case .iterm2:
            return osascript(itermLaunchScript, [command])?.contains("ok") == true
        // CLI-style terminals take the program to run as command-line arguments.
        // We hand them the login shell so rc files load, then the agent command.
        case .wezterm:
            return openLaunch(.wezterm, args: ["start", "--", loginShell, "-lc", keepOpen(command)])
        case .ghostty:
            return openLaunch(.ghostty, args: ["-e", loginShell, "-lc", keepOpen(command)])
        case .alacritty:
            return openLaunch(.alacritty, args: ["-e", loginShell, "-lc", keepOpen(command)])
        case .kitty:
            return openLaunch(.kitty, args: [loginShell, "-lc", keepOpen(command)])
        }
    }

    /// The user's interactive login shell, so launched agents inherit their
    /// profile (PATH, node version managers, etc.).
    private var loginShell: String {
        ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    }

    /// Keep the window on an interactive shell after the agent exits, instead of
    /// the window vanishing the instant it does.
    private func keepOpen(_ command: String) -> String {
        "\(command); exec \(loginShell) -l"
    }

    /// Launch a new instance of a CLI-style terminal through `open`, passing it
    /// the program to run as arguments. `-n` forces a fresh instance so the args
    /// are honored even when the app is already running.
    private func openLaunch(_ t: LaunchTerminal, args: [String]) -> Bool {
        guard let url = appURL(for: t) else { return false }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-na", url.path, "--args"] + args
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
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

    private let itermLaunchScript = """
    on run argv
      tell application "iTerm2"
        activate
        set w to (create window with default profile)
        tell current session of w to write text (item 1 of argv)
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

    /// Resolved CLI path, cached once found. Deliberately NOT `lazy`: a lazy
    /// var would also cache a miss forever, and the strongest resolution
    /// strategy (reading the running GUI process's own path) only works while
    /// WezTerm is actually running — so a miss must be retryable.
    private var cachedWeztermPath: String?
    private var weztermPath: String? {
        if let p = cachedWeztermPath, FileManager.default.isExecutableFile(atPath: p) { return p }
        let fm = FileManager.default
        var found: String?
        let candidates = [
            "/opt/homebrew/bin/wezterm", "/usr/local/bin/wezterm",
            "/Applications/WezTerm.app/Contents/MacOS/wezterm",
            "\(home)/Applications/WezTerm.app/Contents/MacOS/wezterm",
        ]
        found = candidates.first { fm.isExecutableFile(atPath: $0) }
        if found == nil {
            // Derive from the running GUI process: the `wezterm` CLI sits next
            // to `wezterm-gui` in Contents/MacOS. This is the only path that
            // works when the app is quarantine-translocated (launched straight
            // from Downloads/a DMG), where it runs from a random /private/var
            // AppTranslocation directory no fixed candidate can predict.
            let derived = runShell(#"ps -axww -o command= | sed -n 's|^\(.*\)/wezterm-gui.*|\1/wezterm|p' | head -1"#)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !derived.isEmpty, fm.isExecutableFile(atPath: derived) { found = derived }
        }
        if found == nil, let items = try? fm.contentsOfDirectory(atPath: "\(home)/Downloads") {
            for item in items where item.hasPrefix("WezTerm") {
                let p = "\(home)/Downloads/\(item)/WezTerm.app/Contents/MacOS/wezterm"
                if fm.isExecutableFile(atPath: p) { found = p; break }
            }
        }
        cachedWeztermPath = found
        return found
    }

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
