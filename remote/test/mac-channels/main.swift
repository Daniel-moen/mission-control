// Unit checks for Sources/AgentWidget/MiaChannels.swift — Mia's launch flags
// and the iMessage channel's session settings.
// Built and run by test/channels-test.mjs (swiftc, no Xcode project needed).
// With CHANNELS_REAL_HOME set, also resolves against the real ~/.claude and
// prints the settings Mia would launch with (CHANNELS_OUT=<file> writes them).
import Foundation

var failures = 0
func check(_ cond: Bool, _ label: String) {
    print(cond ? "  ✓ \(label)" : "  ✗ \(label)")
    if !cond { failures += 1 }
}
func data(_ s: String) -> Data { s.data(using: .utf8)! }

// Launch args
let strict = MiaChannels.launchArgs(mcpConfig: "/m/mcp.json", settingsPath: nil)
check(strict == ["--mcp-config", "/m/mcp.json", "--strict-mcp-config", "--chrome"], "channel off → unchanged strict launch")
check(MiaChannels.launchArgs(mcpConfig: nil, settingsPath: nil) == ["--strict-mcp-config", "--chrome"], "no mcp.json → still strict")
let on = MiaChannels.launchArgs(mcpConfig: "/m/mcp.json", settingsPath: "/m/cs.json")
check(on == ["--channels", "plugin:imessage@claude-plugins-official", "--settings", "/m/cs.json",
             "--mcp-config", "/m/mcp.json", "--chrome"], "channel on → --channels + --settings, no strict")
check(!on.contains("--strict-mcp-config"), "strict mode would drop the plugin server, so it's gone")
check(on.last!.hasPrefix("--"), "a flag follows --channels, so it can't swallow the prompt")

// installed_plugins.json
let reg = data(#"{"version":2,"plugins":{"imessage@claude-plugins-official":[{"scope":"project","installPath":"/p"},{"scope":"user","installPath":"/u/imessage/0.2.0"}],"x@y":[{"scope":"user","installPath":"/x"}]}}"#)
check(MiaChannels.installPath(installedPlugins: reg) == "/u/imessage/0.2.0", "prefers the user-scope install")
check(MiaChannels.installPath(installedPlugins: data(#"{"plugins":{}}"#)) == nil, "not installed → nil")
check(MiaChannels.installPath(installedPlugins: nil) == nil, "no registry → nil")

// plugin .mcp.json
let pm = data(#"{"mcpServers":{"imessage":{"command":"bun","args":["run","--cwd","${CLAUDE_PLUGIN_ROOT}","--shell=bun","--silent","start"]}}}"#)
check(MiaChannels.serverCommand(pluginMcp: pm, root: "/r") == ["bun", "run", "--cwd", "/r", "--shell=bun", "--silent", "start"],
      "server command with ${CLAUDE_PLUGIN_ROOT} expanded")
check(MiaChannels.serverCommand(pluginMcp: data(#"{"mcpServers":{}}"#), root: "/r") == nil, "no imessage server → nil")

// Mia's mcp.json
check(MiaChannels.serverNames(mcpConfig: data(#"{"mcpServers":{"mc-gmail":{},"a":{}}}"#)) == ["a", "mc-gmail"], "mcp.json server names")
check(MiaChannels.serverNames(mcpConfig: data("not json")).isEmpty, "bad mcp.json → none")

// Settings
let st = MiaChannels.settings(mcpServers: ["mc-gmail"], pluginCommand: ["bun", "x"])
check((st["enabledPlugins"] as? [String: Bool]) == ["imessage@claude-plugins-official": true], "enables the plugin for this session")
let allowed = st["allowedMcpServers"] as? [[String: Any]] ?? []
check(allowed.compactMap { $0["serverName"] as? String } == ["mc-gmail", "claude-in-chrome"], "allowlist: her servers + Chrome only")
check(allowed.compactMap { $0["serverCommand"] as? [String] } == [["bun", "x"]], "allowlist: plugin by command")
check((st["env"] as? [String: String])?["IMESSAGE_APPEND_SIGNATURE"] == "false", "no \"Sent by Claude\" footer on her replies")

// resolve()
let files: [String: Data] = ["/h/.claude/plugins/installed_plugins.json": reg,
                             "/u/imessage/0.2.0/.mcp.json": pm,
                             "/m/mcp.json": data(#"{"mcpServers":{"mc-gmail":{}}}"#)]
let present: Set<String> = ["/h/.bun/bin/bun", "/u/imessage/0.2.0"]
let r = MiaChannels.resolve(home: "/h", mcpConfig: "/m/mcp.json", read: { files[$0] }, exists: { present.contains($0) })
if case .success(let s) = r {
    let a = s["allowedMcpServers"] as? [[String: Any]] ?? []
    check(a.count == 3 && (a.last?["serverCommand"] as? [String])?[3] == "/u/imessage/0.2.0", "resolve: full settings")
} else { check(false, "resolve: full settings") }
let noBun = MiaChannels.resolve(home: "/h", mcpConfig: nil, read: { files[$0] }, exists: { $0 == "/u/imessage/0.2.0" })
if case .failure(.noBun) = noBun { check(true, "resolve: no Bun → strict fallback") } else { check(false, "resolve: no Bun → strict fallback") }
let noPlugin = MiaChannels.resolve(home: "/h", mcpConfig: nil, read: { _ in nil }, exists: { present.contains($0) })
if case .failure(.notInstalled) = noPlugin { check(true, "resolve: no plugin → strict fallback") } else { check(false, "resolve: no plugin → strict fallback") }

if let home = ProcessInfo.processInfo.environment["CHANNELS_REAL_HOME"] {
    let mcp = "\(home)/.mission-control/mia/mcp.json"
    switch MiaChannels.resolve(home: home, mcpConfig: FileManager.default.fileExists(atPath: mcp) ? mcp : nil,
                               read: { FileManager.default.contents(atPath: $0) },
                               exists: { FileManager.default.fileExists(atPath: $0) }) {
    case .success(let s):
        let out = try! JSONSerialization.data(withJSONObject: s, options: [.prettyPrinted, .sortedKeys])
        print(String(data: out, encoding: .utf8)!)
        if let p = ProcessInfo.processInfo.environment["CHANNELS_OUT"] { try! out.write(to: URL(fileURLWithPath: p)) }
        check(true, "real machine: channel resolves")
    case .failure(let why):
        check(false, "real machine: channel resolves (\(why))")
    }
}

exit(failures == 0 ? 0 : 1)
