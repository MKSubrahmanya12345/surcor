import { useCallback, useEffect, useState } from "react";
import type { McpServerConfig, McpServerStatus } from "@forge/shared";
import { agentSocket } from "../../services/agentSocket";
import { useChatStore } from "../../stores/useChatStore";

/**
 * Prompt 6 — Settings panel (activity-bar gear icon): add/remove MCP servers
 * in ~/.forge/mcp.json without hand-editing JSON, and watch each server's live
 * connection state as reported by the agent server. The agent server's file
 * watcher picks changes up automatically; after each successful mutation we
 * also send `mcp_reload` so a missed watch event still re-syncs immediately.
 */

export function Settings() {
  const mcpServers = useChatStore((state) => state.mcpServers);
  const connection = useChatStore((state) => state.connection);
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");

  const refresh = useCallback(async () => {
    try {
      setServers(await window.forge.mcpListServers());
      setError(null);
    } catch (listError) {
      setError(listError instanceof Error ? listError.message : String(listError));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const mutate = async (action: () => Promise<McpServerConfig[]>): Promise<void> => {
    try {
      setServers(await action());
      setError(null);
      // Belt and braces: the server also watches the file itself.
      agentSocket.send({ type: "mcp_reload" });
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    }
  };

  const addServer = (): void => {
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (!trimmedName || !trimmedCommand) {
      setError("Name and command are both required.");
      return;
    }
    void mutate(() => window.forge.mcpAddServer({
      name: trimmedName,
      command: trimmedCommand,
      args: argsText.split(" ").map((arg) => arg.trim()).filter(Boolean),
    })).then(() => { setName(""); setCommand(""); setArgsText(""); });
  };

  const statusFor = (serverName: string): McpServerStatus | undefined =>
    mcpServers.find((server) => server.name === serverName);

  return (
    <div className="settings-panel">
      <h2 className="panel-title">SETTINGS · MCP SERVERS</h2>
      <p className="settings-note">
        External tools from <code>~/.forge/mcp.json</code> (Cursor / Claude Desktop format).
        Their tools appear to the agent as <code>mcp__&lt;server&gt;__&lt;tool&gt;</code>.
      </p>

      {servers.length === 0 && (
        <p className="settings-note">No MCP servers configured yet.</p>
      )}

      <ul className="settings-server-list">
        {servers.map((server) => {
          const status = statusFor(server.name);
          const state = connection === "connected" ? (status?.state ?? "starting") : "stopped";
          return (
            <li key={server.name} className="settings-server">
              <div className="settings-server-row">
                <span className={`settings-dot ${state}`} aria-hidden="true" />
                <span className="settings-server-name">{server.name}</span>
                <button
                  className="settings-remove"
                  onClick={() => void mutate(() => window.forge.mcpRemoveServer({ name: server.name }))}
                  aria-label={`Remove ${server.name}`}
                >
                  Remove
                </button>
              </div>
              <div className="settings-server-command">
                {server.command} {server.args.join(" ")}
              </div>
              <div className="settings-server-status">
                {state === "connected" && `${status?.toolCount ?? 0} tool(s) connected`}
                {state === "starting" && "connecting…"}
                {state === "stopped" && "agent server not connected"}
                {state === "error" && `error: ${status?.error ?? "unknown"}`}
              </div>
              {status && status.toolNames.length > 0 && (
                <div className="settings-server-tools">{status.toolNames.join(", ")}</div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="settings-add">
        <h3 className="settings-add-title">Add MCP server</h3>
        <input
          className="settings-input"
          placeholder="name (e.g. filesystem)"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          className="settings-input"
          placeholder="command (e.g. npx)"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
        />
        <input
          className="settings-input"
          placeholder="args, space-separated (e.g. -y @modelcontextprotocol/server-filesystem ~)"
          value={argsText}
          onChange={(event) => setArgsText(event.target.value)}
        />
        <button className="settings-add-button" onClick={addServer}>Add server</button>
      </div>

      {error && <p className="settings-error" role="alert">{error}</p>}
    </div>
  );
}
