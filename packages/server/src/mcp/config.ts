import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  parseMcpConfig, serializeMcpConfig,
  type McpConfigFile, type McpServerConfig,
} from "@forge/shared";

/**
 * Prompt 6 — server-side accessors for ~/.forge/mcp.json. The parse/serialize
 * rules themselves live in packages/shared/src/mcp-config.ts so the agent
 * server and the Electron Settings UI always agree on the file format byte for
 * byte.
 */

export { parseMcpConfig, serializeMcpConfig, mcpToolName, mcpToolPrefix } from "@forge/shared";
export type { McpConfigFile };

export function mcpConfigPath(env: Record<string, string | undefined> = process.env): string {
  const override = env.MCP_CONFIG_PATH?.trim();
  return override ? override : join(homedir(), ".forge", "mcp.json");
}

export function mcpEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.MCP_ENABLED?.trim().toLowerCase();
  return value === undefined || value === "" || ["1", "true", "yes", "on"].includes(value);
}

export function mcpRequestTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MCP_REQUEST_TIMEOUT_MS;
  const parsed = raw === undefined || raw === "" ? 30_000 : Number(raw);
  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 600_000 ? parsed : 30_000;
}

/** Read and parse the config file. A missing file means "no servers", not an error. */
export function readMcpConfig(path: string): McpConfigFile & { errors: string[] } {
  try {
    return parseMcpConfig(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { servers: [], errors: [] };
    return { servers: [], errors: [`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export function writeMcpConfig(path: string, servers: McpServerConfig[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeMcpConfig(servers), { mode: 0o600 });
}
