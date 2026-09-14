import type { McpServerConfig } from "./types";

/**
 * Prompt 6 — shared, dependency-free parsing/serialization for ~/.forge/mcp.json.
 *
 * The file shape matches Claude Desktop's and Cursor's own config so users can
 * reuse what they already have:
 *
 *   { "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "..."] } } }
 *
 * A plain top-level array of { name, command, args } is also accepted on read.
 * Writes always use the canonical `mcpServers` object shape. Both the agent
 * server (spawning) and the Electron client (Settings UI) use these exact
 * functions, so the file format can never drift between the two processes.
 */

export interface McpConfigFile {
  servers: McpServerConfig[];
}

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function parseEntry(name: string, value: unknown, errors: string[]): McpServerConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`MCP server "${name}": entry must be an object with a command.`);
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!NAME_PATTERN.test(name)) {
    errors.push(`MCP server name "${name}" must contain only letters, numbers, - and _.`);
    return null;
  }
  if (typeof record.command !== "string" || !record.command.trim()) {
    errors.push(`MCP server "${name}": "command" must be a non-empty string.`);
    return null;
  }
  const args = record.args === undefined ? [] : record.args;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    errors.push(`MCP server "${name}": "args" must be an array of strings.`);
    return null;
  }
  const env = record.env === undefined ? undefined : record.env;
  if (env !== undefined && (
    typeof env !== "object" || env === null || Array.isArray(env)
    || Object.values(env as Record<string, unknown>).some((entry) => typeof entry !== "string")
  )) {
    errors.push(`MCP server "${name}": "env" must be an object of string values.`);
    return null;
  }
  return {
    name,
    command: record.command,
    args: args as string[],
    ...(env ? { env: env as Record<string, string> } : {}),
  };
}

/** Parse raw mcp.json text. Tolerant: bad entries are skipped and reported. */
export function parseMcpConfig(raw: string): McpConfigFile & { errors: string[] } {
  const errors: string[] = [];
  const trimmed = raw.trim();
  if (!trimmed) return { servers: [], errors };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { servers: [], errors: [`mcp.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const servers: McpServerConfig[] = [];
  const seen = new Set<string>();
  const push = (entry: McpServerConfig | null): void => {
    if (!entry) return;
    if (seen.has(entry.name)) {
      errors.push(`MCP server "${entry.name}" is defined more than once; keeping the first.`);
      return;
    }
    seen.add(entry.name);
    servers.push(entry);
  };
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const name = typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).name === "string"
        ? (item as { name: string }).name
        : "";
      if (!name) { errors.push("MCP array entries need a \"name\" string."); continue; }
      push(parseEntry(name, item, errors));
    }
    return { servers, errors };
  }
  if (typeof parsed === "object" && parsed !== null) {
    const table = (parsed as Record<string, unknown>).mcpServers ?? parsed;
    if (typeof table !== "object" || table === null || Array.isArray(table)) {
      return { servers: [], errors: ["mcp.json: \"mcpServers\" must be an object keyed by server name."] };
    }
    for (const [name, value] of Object.entries(table as Record<string, unknown>)) {
      push(parseEntry(name, value, errors));
    }
    return { servers, errors };
  }
  return { servers: [], errors: ["mcp.json must contain an object or an array."] };
}

/** Serialize to the canonical { "mcpServers": { name: {...} } } shape. */
export function serializeMcpConfig(servers: McpServerConfig[]): string {
  const table: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  for (const server of servers) {
    table[server.name] = {
      command: server.command,
      args: server.args,
      ...(server.env ? { env: server.env } : {}),
    };
  }
  return `${JSON.stringify({ mcpServers: table }, null, 2)}\n`;
}

/** Namespaced tool name, mirroring Cursor's mcp__<server>__<tool> convention. */
export function mcpToolName(serverName: string, toolName: string): string {
  const clean = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${clean(serverName)}__${clean(toolName)}`;
}

export function mcpToolPrefix(serverName: string): string {
  return `mcp__${serverName.replace(/[^A-Za-z0-9_-]/g, "_")}__`;
}
