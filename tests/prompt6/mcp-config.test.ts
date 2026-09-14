import { expect, test } from "bun:test";
import {
  mcpToolName,
  mcpToolPrefix,
  parseMcpConfig,
  serializeMcpConfig,
} from "../../packages/shared/src/mcp-config";
import {
  mcpConfigPath,
  mcpEnabled,
  mcpRequestTimeoutMs,
  readMcpConfig,
  writeMcpConfig,
} from "../../packages/server/src/mcp/config";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("parses the Claude Desktop / Cursor mcpServers object shape", () => {
  const { servers, errors } = parseMcpConfig(JSON.stringify({
    mcpServers: {
      filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
      slack: { command: "slack-mcp", env: { TOKEN: "x" } },
    },
  }));
  expect(errors).toEqual([]);
  expect(servers).toHaveLength(2);
  expect(servers[0]).toEqual({
    name: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  });
  expect(servers[1]).toEqual({ name: "slack", command: "slack-mcp", args: [], env: { TOKEN: "x" } });
});

test("parses a bare array and a bare object too", () => {
  const fromArray = parseMcpConfig(JSON.stringify([{ name: "a", command: "c" }]));
  expect(fromArray.servers).toEqual([{ name: "a", command: "c", args: [] }]);
  const fromObject = parseMcpConfig(JSON.stringify({ a: { command: "c" } }));
  expect(fromObject.servers).toEqual([{ name: "a", command: "c", args: [] }]);
});

test("rejects invalid entries but keeps the valid ones", () => {
  const { servers, errors } = parseMcpConfig(JSON.stringify({
    mcpServers: {
      good: { command: "ok" },
      "bad name!": { command: "x" },
      noCommand: {},
      badArgs: { command: "x", args: [1] },
    },
  }));
  expect(servers.map((server) => server.name)).toEqual(["good"]);
  expect(errors.length).toBe(3);
  expect(errors.join(" ")).toContain("bad name!");
  expect(errors.join(" ")).toContain("noCommand");
  expect(errors.join(" ")).toContain("badArgs");
});

test("invalid JSON and empty files never throw", () => {
  expect(parseMcpConfig("{ not json").servers).toEqual([]);
  expect(parseMcpConfig("{ not json").errors.length).toBe(1);
  expect(parseMcpConfig("").servers).toEqual([]);
});

test("serialize -> parse round-trips and writes the canonical shape", () => {
  const servers = [
    { name: "fs", command: "cmd", args: ["a", "b"] },
    { name: "with-env", command: "cmd", args: [], env: { K: "v" } },
  ];
  const roundTripped = parseMcpConfig(serializeMcpConfig(servers));
  expect(roundTripped.servers).toEqual(servers);
  expect(Object.keys(JSON.parse(serializeMcpConfig(servers)))).toEqual(["mcpServers"]);
});

test("duplicate names keep the first entry and report an error", () => {
  const { servers, errors } = parseMcpConfig(JSON.stringify([{ name: "x", command: "1" }, { name: "x", command: "2" }]));
  expect(servers).toEqual([{ name: "x", command: "1", args: [] }]);
  expect(errors.length).toBe(1);
});

test("tool names are namespaced and sanitized", () => {
  expect(mcpToolName("filesystem", "read_file")).toBe("mcp__filesystem__read_file");
  expect(mcpToolName("my server", "do.thing")).toBe("mcp__my_server__do_thing");
  expect(mcpToolPrefix("slack")).toBe("mcp__slack__");
});

test("file helpers: missing file is empty; write -> read round-trips", () => {
  const dir = mkdtempSync(`${tmpdir()}/forge-mcp-`);
  const path = join(dir, ".forge", "mcp.json");
  expect(readMcpConfig(path)).toEqual({ servers: [], errors: [] });
  writeMcpConfig(path, [{ name: "fs", command: "npx", args: [] }]);
  expect(readMcpConfig(path).servers).toEqual([{ name: "fs", command: "npx", args: [] }]);
  expect(readFileSync(path, "utf8")).toContain("mcpServers");
});

test("env knobs have sane defaults", () => {
  expect(mcpEnabled({})).toBe(true);
  expect(mcpEnabled({ MCP_ENABLED: "false" })).toBe(false);
  expect(mcpRequestTimeoutMs({})).toBe(30_000);
  expect(mcpRequestTimeoutMs({ MCP_REQUEST_TIMEOUT_MS: "5000" })).toBe(5_000);
  expect(mcpRequestTimeoutMs({ MCP_REQUEST_TIMEOUT_MS: "banana" })).toBe(30_000);
  expect(mcpConfigPath({}).endsWith(join(".forge", "mcp.json"))).toBe(true);
  expect(mcpConfigPath({ MCP_CONFIG_PATH: "/tmp/custom.json" })).toBe("/tmp/custom.json");
});
