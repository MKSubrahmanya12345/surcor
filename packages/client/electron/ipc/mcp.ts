import { ipcMain } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  IPC, parseMcpConfig, serializeMcpConfig,
  type McpServerConfig,
} from "@forge/shared";

/**
 * Prompt 6 — Settings UI backend: manages ~/.forge/mcp.json from the Electron
 * main process. The agent server owns the LIVE MCP connections (it re-syncs
 * via its own file watcher and the renderer's `mcp_reload` message); these
 * handlers only own the FILE so users never hand-edit JSON. Parsing uses the
 * exact helpers from packages/shared, so client and server never disagree
 * about the file format.
 */

function configPath(): string {
  const override = process.env.MCP_CONFIG_PATH?.trim();
  return override || join(homedir(), ".forge", "mcp.json");
}

function listServers(): McpServerConfig[] {
  try {
    return parseMcpConfig(readFileSync(configPath(), "utf8")).servers;
  } catch {
    return []; // missing or unreadable file = no configured servers
  }
}

function writeServers(servers: McpServerConfig[]): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeMcpConfig(servers), { mode: 0o600 });
}

const addPayload = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Use letters, numbers, - and _ only."),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
}).strict();

const removePayload = z.object({ name: z.string().min(1) }).strict();

export function registerMcpHandlers(): void {
  ipcMain.handle(IPC.MCP_LIST_SERVERS, () => listServers());

  ipcMain.handle(IPC.MCP_ADD_SERVER, (_event, raw: unknown) => {
    const parsed = addPayload.parse(raw);
    const servers = listServers();
    if (servers.some((server) => server.name === parsed.name)) {
      throw new Error(`An MCP server named "${parsed.name}" already exists.`);
    }
    servers.push({
      name: parsed.name,
      command: parsed.command,
      args: parsed.args ?? [],
      ...(parsed.env ? { env: parsed.env } : {}),
    });
    writeServers(servers);
    return listServers();
  });

  ipcMain.handle(IPC.MCP_REMOVE_SERVER, (_event, raw: unknown) => {
    const { name } = removePayload.parse(raw);
    const servers = listServers();
    if (!servers.some((server) => server.name === name)) {
      throw new Error(`No MCP server named "${name}".`);
    }
    writeServers(servers.filter((server) => server.name !== name));
    return listServers();
  });
}
