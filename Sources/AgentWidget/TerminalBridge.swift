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

/// One live `claude` process, as seen by a scan pass: identity (pid + the
/// sessionId Claude Code publishes for it), where it runs, and resource usage.
/// Keyed by PID — never by working directory — so several agents in the same
/// folder stay fully distinct.
struct ClaudeProcess: Equatable {
    var pid: Int32
    var sessionId: String    // from ~/.claude/sessions/<pid>.json; "" if absent
    var name: String         // Claude Code's per-session name ("" if absent) —
                             // unique-ish, disambiguates same-folder agents
    var cwd: String          // symlink-resolved working directory
    var cpuPercent: Double   // instantaneous %CPU from ps
    var rssMB: Double        // resident memory, MB
    var startedAt: Date?     // process start, for stable fallback ordering
    var terminal: TerminalInfo
}

/// Focuses terminals and types replies into them across the common macOS
/// terminals. Scriptable apps (iTerm2, Terminal, WezTerm) target the exact
/// tab/pane by TTY; everything else falls back to synthesized keystrokes,
/// which needs Accessibility permission and types into the focused tab.
final class TerminalBridge {
    private let home = NSHomeDirectory()

    // MARK: Discovery

    /// Every running `claude` process, one record per PID — identity, cwd, TTY,
    /// owning terminal app, and resource usage. Each record is then joined with
    /// Claude Code's own session registry (~/.claude/sessions/<pid>.json) to
    /// learn which sessionId the process belongs to, so an agent maps to ITS
    /// process even when several run from the same folder.
    /// Returns nil when the scan itself failed (shell couldn't run, `ps`
    /// errored, …) — callers must treat that as "unknown", NOT as "no agents",
    /// or one hiccup under load marks every live agent dead at once.
    func scan() -> [ClaudeProcess]? {
        let script = #"""
        ps -axww -o pid=,pcpu=,rss=,lstart=,command= | while read -r p cpu rss d1 d2 d3 d4 d5 rest; do
          case "$rest" in claude|*/claude|claude\ *|*/claude\ *) ;; *) continue;; esac
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
          printf '%s\t%s\t%s\t%s %s %s %s %s\t%s\t%s\t%s\n' "$p" "$cpu" "$rss" "$d1" "$d2" "$d3" "$d4" "$d5" "$cwd" "$tty" "$app|$appcmd"
        done
        echo '__MC_SCAN_OK__'
        """#
        // LC_ALL=C pins ps's number and date formats: a comma-decimal locale
        // prints pcpu as "24,7" (unparseable) and reorders lstart's fields.
        let out = runShell(script, env: ["LC_ALL": "C"])
        // No sentinel ⇒ the script never ran to completion — report failure
        // rather than an (indistinguishable) empty fleet.
        guard out.contains("__MC_SCAN_OK__") else { return nil }
        let sessions = sessionRegistry()
        var result: [ClaudeProcess] = []
        for line in out.split(separator: "\n") where line != "__MC_SCAN_OK__" {
            let parts = line.components(separatedBy: "\t")
            guard parts.count >= 7, let pid = Int32(parts[0]), !parts[4].isEmpty else { continue }
            let appParts = parts[6].components(separatedBy: "|")
            let app = appParts.first ?? ""
            let appcmd = appParts.dropFirst().joined(separator: "|")
            let tty = parts[5].isEmpty || parts[5] == "??" ? "" : "/dev/\(parts[5])"
            result.append(ClaudeProcess(
                pid: pid,
                sessionId: sessions[pid]?.sessionId ?? "",
                name: sessions[pid]?.name ?? "",
                cwd: resolved(parts[4]),
                cpuPercent: Double(parts[1]) ?? 0,
                rssMB: (Double(parts[2]) ?? 0) / 1024,
                startedAt: Self.lstartFormatter.date(from: parts[3]),
                terminal: TerminalInfo(tty: tty, app: app, bundlePath: bundle(fromCommand: appcmd))))
        }
        return result
    }

    /// pid → (sessionId, name), from the per-process registry files Claude Code
    /// writes at ~/.claude/sessions/<pid>.json. Only trusted for PIDs the caller
    /// has independently confirmed to be live `claude` processes (a dead
    /// session's file may linger until its PID is recycled).
    private func sessionRegistry() -> [Int32: (sessionId: String, name: String)] {
        let dir = "\(home)/.claude/sessions"
        guard let files = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return [:] }
        var map: [Int32: (sessionId: String, name: String)] = [:]
        for f in files where f.hasSuffix(".json") {
            guard let pid = Int32((f as NSString).deletingPathExtension),
                  let data = FileManager.default.contents(atPath: "\(dir)/\(f)"),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let sid = obj["sessionId"] as? String, !sid.isEmpty else { continue }
            map[pid] = (sid, obj["name"] as? String ?? "")
        }
        return map
    }

    /// Parses ps's `lstart` column ("Tue Jul  7 21:38:20 2026").
    private static let lstartFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEE MMM d HH:mm:ss yyyy"
        return f
    }()

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

    /// Send a single raw keystroke (no trailing newline) so a remote viewer can
    /// drive Claude Code's interactive selection prompts — pressing a digit
    /// picks a numbered option; named keys navigate/confirm. WezTerm and iTerm2
    /// deliver the exact bytes to the pane by TTY; other terminals fall back to
    /// synthesized keystrokes into the focused window (needs Accessibility).
    @discardableResult
    func sendKey(_ key: String, to info: TerminalInfo) -> Bool {
        let seq = Self.keySequence(key)
        guard !seq.isEmpty else { return false }
        switch info.app {
        case "WezTerm":
            guard let id = weztermPaneId(forTty: info.tty) else { return false }
            return weztermCLI(["send-text", "--no-paste", "--pane-id", "\(id)", seq]) != nil
        case "iTerm2":
            return osascript(iTermSendRawScript, [info.tty, seq])?.contains("ok") == true
        default:
            guard accessibilityTrusted(prompt: true) else { return false }
            activateBundle(info)
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.25) { [weak self] in
                self?.typeUnicode(seq)   // no pressReturn — a keystroke, not a line
            }
            return true
        }
    }

    /// Map a key name to the bytes a terminal expects. Single visible characters
    /// (digits/letters) pass through as-is; the rest are the usual VT sequences.
    static func keySequence(_ key: String) -> String {
        switch key.lowercased() {
        case "up":              return "\u{1b}[A"
        case "down":            return "\u{1b}[B"
        case "right":           return "\u{1b}[C"
        case "left":            return "\u{1b}[D"
        case "enter", "return": return "\r"
        case "esc", "escape":   return "\u{1b}"
        case "tab":             return "\t"
        case "space":           return " "
        default:                return key.count == 1 ? key : ""
        }
    }

    // MARK: Screen mirror

    /// The visible contents of the agent's terminal tab/pane — literally what
    /// you'd see standing at the Mac, including the claude TUI, its prompt and
    /// any permission dialog. With `scrollback`, includes recent history above
    /// the viewport (for the remote panel's full terminal view). Only
    /// scriptable terminals can be read (iTerm2 / Terminal.app by TTY via
    /// AppleScript, WezTerm via its CLI); returns nil for the rest.
    func screenText(of info: TerminalInfo, scrollback: Bool = false) -> String? {
        guard !info.tty.isEmpty else { return nil }
        switch info.app {
        case "iTerm2":   return osascript(scrollback ? iTermHistoryScript : iTermScreenScript, [info.tty])
        case "Terminal": return osascript(scrollback ? terminalHistoryScript : terminalScreenScript, [info.tty])
        case "WezTerm":
            guard let id = weztermPaneId(forTty: info.tty) else { return nil }
            var args = ["get-text", "--pane-id", "\(id)"]
            if scrollback { args += ["--start-line", "-400"] }
            return weztermCLI(args)
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

    // Scrollback-inclusive variants, used for the remote panel's full terminal
    // view. Each falls back to the visible screen if the richer property isn't
    // available in the running app version.
    private let iTermHistoryScript = """
    on run argv
      set theTty to item 1 of argv
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if (tty of s) is theTty then
                try
                  return text of s
                on error
                  return contents of s
                end try
              end if
            end repeat
          end repeat
        end repeat
      end tell
      return ""
    end run
    """

    private let terminalHistoryScript = """
    on run argv
      set theTty to item 1 of argv
      tell application "Terminal"
        repeat with w in windows
          repeat with t in tabs of w
            if (tty of t) is theTty then
              try
                return history of t
              on error
                return contents of t
              end try
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

    /// Bundle id, not path: a terminal launched from a DMG or ~/Downloads runs
    /// quarantine-translocated out of /private/var, so its path tells us nothing.
    private func isRunning(_ t: LaunchTerminal) -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: t.bundleID).isEmpty
    }

    /// Terminals that can drop a new agent into a tab of a window they already
    /// have open, rather than spawning a window of their own.
    func supportsNewTab(_ t: LaunchTerminal) -> Bool {
        t == .wezterm || t == .iterm2
    }

    /// Run `command` in `terminal`, inside a fresh login shell so the user's PATH
    /// — and therefore `claude` — resolves exactly as it does when they run it by
    /// hand. Launching into the wrong shell environment is why an agent could
    /// silently fail to start and so never show up in the fleet.
    ///
    /// With `newTab`, the agent lands in a tab of the terminal's existing window
    /// when it has one. That keeps a full-screen terminal full-screen: a new
    /// window would open in its own space and drag the user out of whatever they
    /// were watching. Falls back to a new window when the terminal can't do tabs
    /// or has nothing open yet. Returns true if the launch was dispatched.
    @discardableResult
    func launch(command: String, in terminal: LaunchTerminal, newTab: Bool = true) -> Bool {
        if newTab, launchInTab(command: command, in: terminal) { return true }
        switch terminal {
        case .terminal:
            return osascript(terminalLaunchScript, [command])?.contains("ok") == true
        case .iterm2:
            return osascript(itermLaunchScript, [command])?.contains("ok") == true
        // CLI-style terminals take the program to run as command-line arguments.
        // We hand them the login shell so rc files load, then the agent command.
        // -i matters: a non-interactive `zsh -lc` skips ~/.zshrc, where PATH
        // additions like ~/.local/bin (claude's home) usually live — fatal when
        // the app itself was started by launchd with a bare PATH to inherit.
        case .wezterm:
            return openLaunch(.wezterm, args: ["start", "--", loginShell, "-ilc", keepOpen(command)])
        case .ghostty:
            return openLaunch(.ghostty, args: ["-e", loginShell, "-ilc", keepOpen(command)])
        case .alacritty:
            return openLaunch(.alacritty, args: ["-e", loginShell, "-ilc", keepOpen(command)])
        case .kitty:
            return openLaunch(.kitty, args: [loginShell, "-ilc", keepOpen(command)])
        }
    }

    /// Add the agent as a tab of the terminal's frontmost existing window,
    /// leaving that window exactly where it is. Neither backend activates the
    /// app: the launch is meant to be unobtrusive, and pulling a full-screen
    /// terminal forward would yank the user across spaces. Returns false when
    /// this terminal has no tab backend, or no window to put a tab in.
    private func launchInTab(command: String, in terminal: LaunchTerminal) -> Bool {
        // A not-yet-running terminal has no window to reuse, and asking anyway
        // has side effects: `tell application "iTerm2"` launches iTerm2, and
        // `wezterm cli list` starts a headless mux server. Both would then race
        // the new window we're about to open.
        guard isRunning(terminal) else { return false }
        switch terminal {
        case .wezterm:
            guard let window = weztermFocusedWindowId() else { return false }
            return weztermCLI(["spawn", "--window-id", "\(window)",
                               "--", loginShell, "-ilc", keepOpen(command)]) != nil
        case .iterm2:
            return osascript(itermTabLaunchScript, [command])?.contains("ok") == true
        default:
            return false
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

    // Anything but "ok" sends the caller back to opening a real window. iTerm2
    // counts its own hidden "hotkey window", so an all-closed iTerm2 can still
    // report windows; `create tab` on it is still the right move.
    private let itermTabLaunchScript = """
    on run argv
      tell application "iTerm2"
        if (count of windows) is 0 then return "nowindow"
        tell current window
          set t to (create tab with default profile)
          tell current session of t to write text (item 1 of argv)
        end tell
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

    // Like iTermSendScript but appends no newline — used for single raw keys
    // (menu digits, arrows, enter, esc) that drive interactive prompts.
    private let iTermSendRawScript = """
    on run argv
      set theTty to item 1 of argv
      set theMsg to item 2 of argv
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if (tty of s) is theTty then
                tell s to write text theMsg newline no
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
        // A nil return means the CLI exited non-zero (bad socket/path, gone pane)
        // — treat the message body's send-text as the source of truth so a silent
        // failure surfaces as "Couldn't reach terminal" instead of a false "Sent".
        guard weztermCLI(["send-text", "--no-paste", "--pane-id", "\(id)", text]) != nil else { return false }
        weztermCLI(["send-text", "--no-paste", "--pane-id", "\(id)", "\r"])
        return true
    }

    /// The window WezTerm last had focus in — where the user is actually looking,
    /// and so where a new agent's tab belongs. Falls back to any open window, and
    /// is nil only when WezTerm has no windows at all (or isn't running), which
    /// is the launcher's cue to open one.
    private func weztermFocusedWindowId() -> Int? {
        let panes = weztermPanes()
        guard !panes.isEmpty else { return nil }
        if let focused = weztermFocusedPaneId(),
           let pane = panes.first(where: { ($0["pane_id"] as? Int) == focused }) {
            return pane["window_id"] as? Int
        }
        return panes.first?["window_id"] as? Int
    }

    /// `focused_pane_id` from the GUI's own client record — the only place
    /// WezTerm reports which pane has focus across windows.
    private func weztermFocusedPaneId() -> Int? {
        guard let json = weztermCLI(["list-clients", "--format", "json"]),
              let data = json.data(using: .utf8),
              let clients = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
        return clients.compactMap { $0["focused_pane_id"] as? Int }.first
    }

    private func weztermPanes() -> [[String: Any]] {
        guard let json = weztermCLI(["list", "--format", "json"]),
              let data = json.data(using: .utf8),
              let panes = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return panes
    }

    private func weztermPaneId(forTty tty: String) -> Int? {
        guard !tty.isEmpty else { return nil }
        for pane in weztermPanes() where (pane["tty_name"] as? String) == tty {
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
