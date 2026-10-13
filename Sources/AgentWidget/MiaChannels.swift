import Foundation

/// Mia's launch flags, and the iMessage channel that rides on them
/// (docs/mia.md §11). Pure functions over file contents so the rules can be
/// unit-tested without the app (remote/test/channels-test.mjs).
///
/// The channel is Anthropic's `imessage@claude-plugins-official` plugin,
/// started with `--channels`. Two things make it awkward for Mia:
///   - `--strict-mcp-config` drops plugin MCP servers, channel or not. So with
///     the channel on she launches without it, and a session-only `--settings`
///     file does the strict config's job instead: `allowedMcpServers` lets
///     through only her mcp.json servers, Claude in Chrome and the plugin's
///     server (a policy list, so Daniel's claude.ai connectors and user-scope
///     servers are blocked exactly as before).
///   - The plugin is installed at user scope but left *disabled* there, so
///     Daniel's sessions and the executors don't each spawn a chat.db poller.
///     The same settings file enables it for Mia's session only.
/// A plugin server only matches `allowedMcpServers` by its command line
/// (`serverCommand`), which embeds the versioned install path — so the file
/// is rebuilt from installed_plugins.json at every launch.
enum MiaChannels {
    static let plugin = "imessage@claude-plugins-official"
    static let channel = "plugin:" + plugin
    /// The server name inside the plugin's .mcp.json.
    static let serverName = "imessage"
    /// In-process, from `--chrome`; still subject to the allowlist.
    static let chromeServer = "claude-in-chrome"

    /// Where the plugin is installed, from ~/.claude/plugins/installed_plugins.json
    /// (`{"plugins": {"name@market": [{scope, installPath}, …]}}`). Prefers the
    /// user-scope install.
    static func installPath(installedPlugins data: Data?) -> String? {
        guard let data,
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let plugins = root["plugins"] as? [String: Any],
              let entries = plugins[plugin] as? [[String: Any]] else { return nil }
        let pick = entries.first { ($0["scope"] as? String) == "user" } ?? entries.first
        guard let path = pick?["installPath"] as? String, !path.isEmpty else { return nil }
        return path
    }

    /// The command line Claude Code runs for the plugin's server — `command`
    /// then `args` from its .mcp.json, with ${CLAUDE_PLUGIN_ROOT} expanded.
    /// This is what `serverCommand` in allowedMcpServers is compared against.
    static func serverCommand(pluginMcp data: Data?, root: String) -> [String]? {
        guard let data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let servers = (json["mcpServers"] as? [String: Any]) ?? json
        guard let server = servers[serverName] as? [String: Any],
              let command = server["command"] as? String, !command.isEmpty else { return nil }
        let args = (server["args"] as? [String]) ?? []
        return ([command] + args).map {
            $0.replacingOccurrences(of: "${CLAUDE_PLUGIN_ROOT}", with: root)
        }
    }

    /// Server names in Mia's mcp.json, sorted.
    static func serverNames(mcpConfig data: Data?) -> [String] {
        guard let data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let servers = json["mcpServers"] as? [String: Any] else { return [] }
        return servers.keys.sorted()
    }

    /// The session-only settings that stand in for `--strict-mcp-config`.
    static func settings(mcpServers: [String], pluginCommand: [String]) -> [String: Any] {
        var allowed: [[String: Any]] = (mcpServers + [chromeServer]).map { ["serverName": $0] }
        allowed.append(["serverCommand": pluginCommand])
        return ["enabledPlugins": [plugin: true], "allowedMcpServers": allowed]
    }

    /// Mia's flags before the prompt. `settingsPath` is the written settings
    /// file when the channel is on, nil for the classic strict launch.
    /// `--channels` is variadic and would swallow the prompt as a second
    /// channel, so it goes first and is always followed by another flag.
    static func launchArgs(mcpConfig: String?, settingsPath: String?) -> [String] {
        var args: [String] = []
        if let settingsPath { args += ["--channels", channel, "--settings", settingsPath] }
        if let mcpConfig { args += ["--mcp-config", mcpConfig] }
        if settingsPath == nil {
            // Without mcp.json she still launches strict — no MCP at all
            // rather than Daniel's.
            args.append("--strict-mcp-config")
        }
        // --chrome adds Claude in Chrome (an in-process server, so the strict
        // config doesn't drop it): she drives Daniel's Chrome through the
        // extension. Harmless when Chrome isn't connected — the tools just error.
        args.append("--chrome")
        return args
    }

    /// Bun, which runs the plugin's server. The installer puts it in ~/.bun/bin
    /// (and on PATH via ~/.zshrc); Homebrew in its own bin.
    static func bunPath(home: String, exists: (String) -> Bool) -> String? {
        ["\(home)/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"].first(where: exists)
    }

    /// Everything the channel needs, or why it can't run. Reads the plugin
    /// registry and the plugin's .mcp.json; writes nothing.
    static func resolve(home: String, mcpConfig: String?,
                        read: (String) -> Data?, exists: (String) -> Bool) -> Result<[String: Any], Unavailable> {
        guard bunPath(home: home, exists: exists) != nil else { return .failure(.noBun) }
        guard let root = installPath(installedPlugins: read("\(home)/.claude/plugins/installed_plugins.json")),
              exists(root) else { return .failure(.notInstalled) }
        guard let cmd = serverCommand(pluginMcp: read("\(root)/.mcp.json"), root: root) else {
            return .failure(.unreadable)
        }
        let names = mcpConfig.map { serverNames(mcpConfig: read($0)) } ?? []
        return .success(settings(mcpServers: names, pluginCommand: cmd))
    }

    enum Unavailable: Error, CustomStringConvertible {
        case noBun, notInstalled, unreadable
        var description: String {
            switch self {
            case .noBun: return "Bun is not installed"
            case .notInstalled: return "\(plugin) is not installed"
            case .unreadable: return "\(plugin) has no readable .mcp.json"
            }
        }
    }
}
