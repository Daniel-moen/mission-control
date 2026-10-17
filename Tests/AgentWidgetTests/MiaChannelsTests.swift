import Foundation
import Testing
@testable import AgentWidget

// Mia's iMessage channel settings (task 0208): the plugin's server inherits the
// session env, and IMESSAGE_APPEND_SIGNATURE=false drops its "Sent by Claude" footer.

@Test func channelSettingsTurnOffTheSignature() throws {
    let st = MiaChannels.settings(mcpServers: ["mc-gmail"], pluginCommand: ["bun", "x"])
    let env = try #require(st["env"] as? [String: String])
    #expect(env["IMESSAGE_APPEND_SIGNATURE"] == "false")
}

@Test func resolvedChannelSettingsCarryTheEnv() throws {
    let reg = Data(#"{"plugins":{"imessage@claude-plugins-official":[{"scope":"user","installPath":"/u/im"}]}}"#.utf8)
    let pm = Data(#"{"mcpServers":{"imessage":{"command":"bun","args":["run","--cwd","${CLAUDE_PLUGIN_ROOT}"]}}}"#.utf8)
    let files = ["/h/.claude/plugins/installed_plugins.json": reg, "/u/im/.mcp.json": pm]
    let present: Set<String> = ["/h/.bun/bin/bun", "/u/im"]
    let r = MiaChannels.resolve(home: "/h", mcpConfig: nil, read: { files[$0] }, exists: { present.contains($0) })
    guard case .success(let st) = r else { Issue.record("resolve failed: \(r)"); return }
    // Survives the JSON round trip the app does when it writes the file.
    let back = try JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: st)) as? [String: Any]
    #expect((back?["env"] as? [String: String]) == ["IMESSAGE_APPEND_SIGNATURE": "false"])
}
