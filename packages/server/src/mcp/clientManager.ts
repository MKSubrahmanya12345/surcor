import { statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { Subprocess } from "bun";
import type { McpServerConfig, McpServerStatus, ServerMessage, ToolResult } from "@forge/shared";
import { registerTool, toolRegistry } from "../tools/registry";
import { serverEnv } from "../config";
import {
  mcpEnabled, mcpConfigPath, mcpRequestTimeoutMs, mcpToolName, mcpToolPrefix, readMcpConfig,
} from "./config";

/**
 * Prompt 6 — MCP client: connects the agent to arbitrary external tool servers.
 *
 * Each configured server is spawned as a child process and spoken to over
 * stdio with MCP's JSON-RPC 2.0 transport (LSP-style `Content-Length` framing,
 * exactly what the official @modelcontextprotocol/sdk StdioClientTransport
 * does). The SDK is deliberately not a runtime dependency here: the protocol
 * surface Forge needs (initialize / tools\/list / tools\/call) is small, and a
 * dependency-free transport keeps the server fully self-contained — the same
 * reason Prompt 3 uses direct fetch() calls instead of provider SDKs. The wire
 * format is identical, so any stdio MCP server (Claude Desktop / Cursor
 * configs included) works unchanged.
 *
 * Tools are registered into the SAME tools/registry.ts as every other tool,
 * namespaced `mcp__<serverName>__<toolName>`, so agent/loop.ts dispatches them
 * generically with zero changes.
 */

const JSONRPC_VERSION = "2.0";
const PROTOCOL_VERSION = "2024-11-05";
const HANDSHAKE_TIMEOUT_MS = 20_000;

interface JsonRpcRequest { jsonrpc: "2.0"; id: number; method: string; params?: unknown }
interface JsonRpcResponse {
  jsonrpc: "2.0"; id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: Timer;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

class McpStdioConnection {
  private proc: Subprocess | null = null;
  private buffer = new Uint8Array(0);
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private closed = false;

  constructor(
    private readonly config: McpServerConfig,
    private readonly timeoutMs: number,
    private readonly onExit: (reason: string) => void,
  ) {}

  async start(): Promise<void> {
    let proc: Subprocess;
    try {
      proc = Bun.spawn([this.config.command, ...this.config.args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...(process.env as Record<string, string>), ...(this.config.env ?? {}) },
      });
    } catch (error) {
      throw new Error(`Could not spawn "${this.config.command}": ${errorMessage(error)}`);
    }
    this.proc = proc;
    void this.readLoop(proc);
    void this.drainStderr(proc);
    void proc.exited.then((code) => {
      if (this.closed) return;
      this.failAll(new Error(`MCP server "${this.config.name}" exited (code ${code}).`));
      this.onExit(`process exited with code ${code}`);
    });
    try {
      const initialize = await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "forge", version: "0.1.0" },
      }, HANDSHAKE_TIMEOUT_MS);
      if (typeof initialize !== "object" || initialize === null) {
        throw new Error("MCP server returned an invalid initialize response.");
      }
      this.notify("notifications/initialized", {});
    } catch (error) {
      this.stop();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async listTools(): Promise<McpToolSpec[]> {
    const result = await this.request("tools/list", {}) as { tools?: unknown };
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools.filter((tool): tool is McpToolSpec =>
      typeof tool === "object" && tool !== null && typeof (tool as McpToolSpec).name === "string");
  }

  async rawCallTool(toolCallId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (this.closed || !this.proc) throw new Error(`MCP server "${this.config.name}" is not running.`);
    const response = await this.request("tools/call", { name, arguments: args }) as {
      content?: unknown; isError?: boolean;
    };
    const blocks = Array.isArray(response?.content) ? response.content : [];
    const output = blocks.map((block) => {
      if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
        return String((block as { text?: unknown }).text ?? "");
      }
      return JSON.stringify(block);
    }).join("\n");
    const failed = response?.isError === true;
    return {
      toolCallId,
      ok: !failed,
      output: failed ? "" : (output || "(no output)"),
      ...(failed ? { error: output || "MCP tool reported an error." } : {}),
    };
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error(`MCP server "${this.config.name}" was stopped.`));
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      const stdin = proc.stdin as { end?: () => void } | null | undefined;
      try { stdin?.end?.(); } catch { /* already closed */ }
      try { proc.kill(); } catch { /* already exited */ }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.closed || !this.proc) return Promise.reject(new Error("connection is closed"));
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, {
        timer,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (reason) => { clearTimeout(timer); reject(reason); },
      });
      try {
        this.send(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: JSONRPC_VERSION, method, params } as JsonRpcRequest);
  }

  private send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "utf8");
    const stdin = this.proc?.stdin as { write?: (chunk: Buffer) => unknown; flush?: () => unknown } | null | undefined;
    if (!stdin?.write) throw new Error("MCP stdin is unavailable.");
    stdin.write(header);
    stdin.write(body);
    stdin.flush?.();
  }

  private async readLoop(proc: Subprocess): Promise<void> {
    try {
      const stdout = proc.stdout;
      if (stdout instanceof ReadableStream) {
        for await (const chunk of stdout as unknown as AsyncIterable<Uint8Array>) {
          this.append(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
        }
      }
    } catch { /* stream ended; the exited handler reports the state change */ }
  }

  private async drainStderr(proc: Subprocess): Promise<void> {
    try {
      const stderr = proc.stderr;
      if (stderr instanceof ReadableStream) {
        for await (const _chunk of stderr as unknown as AsyncIterable<Uint8Array>) { /* discard */ }
      }
    } catch { /* ignore */ }
  }

  private append(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.byteLength);
    this.buffer = merged;
    // LSP-style framing: ASCII headers terminated by a blank line, then a JSON
    // body of exactly Content-Length bytes. All slicing is done on raw bytes so
    // multi-byte UTF-8 split across chunks cannot corrupt the stream.
    const CRLFCRLF = [13, 10, 13, 10];
    const indexOfSeparator = (from: number): number => {
      outer: for (let i = from; i + 3 < this.buffer.byteLength; i++) {
        for (let j = 0; j < 4; j++) if (this.buffer[i + j] !== CRLFCRLF[j]) continue outer;
        return i;
      }
      return -1;
    };
    for (;;) {
      const headerEnd = indexOfSeparator(0);
      if (headerEnd < 0) return;
      const header = Buffer.from(this.buffer.subarray(0, headerEnd)).toString("latin1");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4); // skip unparseable header
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.byteLength - bodyStart < length) return; // wait for more data
      const body = Buffer.from(this.buffer.subarray(bodyStart, bodyStart + length)).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        this.handleMessage(JSON.parse(body) as Record<string, unknown>);
      } catch { /* ignore malformed JSON from a misbehaving server */ }
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    // A request FROM the server (sampling, roots, ...): politely refuse.
    if (typeof message.method === "string" && typeof message.id === "number" && (message.result === undefined && message.error === undefined)) {
      this.send({ jsonrpc: JSONRPC_VERSION, id: message.id, error: { code: -32_601, message: "Forge does not implement server-initiated requests." } });
      return;
    }
    if (typeof message.id !== "number") return; // notification: nothing to track
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    const response = message as unknown as JsonRpcResponse;
    if (response.error) pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
    else pending.resolve(response.result);
  }
}

interface RunningServer {
  config: McpServerConfig;
  connection: McpStdioConnection;
  tools: string[];           // namespaced names registered into tools/registry
}

export type McpStatusListener = (servers: McpServerStatus[]) => void;

class McpClientManager {
  private running = new Map<string, RunningServer>();
  private failed = new Map<string, string>(); // name -> error
  private listeners = new Set<McpStatusListener>();
  private watcher: FSWatcher | null = null;
  private pollTimer: Timer | null = null;
  private lastMtimeMs: number | null = null;
  private reloadChain: Promise<void> = Promise.resolve();
  private reloadAgain = false;
  private stopped = false;

  constructor(
    private readonly configPath: string,
    private readonly timeoutMs: number,
  ) {}

  statuses(): McpServerStatus[] {
    const names = new Set([...this.running.keys(), ...this.failed.keys()]);
    return [...names].sort().map((name) => {
      const running = this.running.get(name);
      if (running) {
        // Servers only enter `running` after a successful initialize+tools/list.
        return { name, state: "connected" as const, toolCount: running.tools.length, toolNames: running.tools.slice() };
      }
      return { name, state: "error" as const, toolCount: 0, toolNames: [], error: this.failed.get(name) };
    });
  }

  onStatus(listener: McpStatusListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emitStatus(): void {
    const statuses = this.statuses();
    for (const listener of this.listeners) listener(statuses);
  }

  async reload(): Promise<void> {
    // Serialize reloads; if changes arrive while one is running, run once more.
    if (this.reloadAgain) return this.reloadChain;
    this.reloadAgain = true;
    this.reloadChain = this.reloadChain.then(async () => {
      do {
        this.reloadAgain = false;
        if (!this.stopped) await this.syncOnce();
      } while (this.reloadAgain && !this.stopped);
    }).catch((error: unknown) => {
      console.error(`[mcp] reload failed: ${errorMessage(error)}`);
    });
    return this.reloadChain;
  }

  private async syncOnce(): Promise<void> {
    const { servers, errors } = readMcpConfig(this.configPath);
    for (const error of errors) console.error(`[mcp] ${error}`);
    // A wholesale parse failure (e.g. reading a half-written file during an
    // editor's non-atomic save) must NOT tear down healthy servers. The next
    // successful save triggers another sync via the watcher/poll.
    if (errors.some((error) => error.startsWith("mcp.json is not valid JSON"))) return;
    const wanted = new Map(servers.map((server) => [server.name, server]));

    for (const [name, running] of [...this.running]) {
      const next = wanted.get(name);
      if (!next || JSON.stringify(next) !== JSON.stringify(running.config)) {
        this.stopServer(name);
      }
    }
    for (const name of [...this.failed.keys()]) {
      if (!wanted.has(name)) { this.failed.delete(name); }
    }
    for (const [name, config] of wanted) {
      if (this.running.has(name)) continue;
      await this.startServer(config);
    }
    this.emitStatus();
  }

  private unregisterTools(serverName: string): void {
    const prefix = mcpToolPrefix(serverName);
    for (const key of [...toolRegistry.keys()]) {
      if (key.startsWith(prefix)) toolRegistry.delete(key);
    }
  }

  private async startServer(config: McpServerConfig): Promise<void> {
    this.failed.delete(config.name);
    this.unregisterTools(config.name);
    const connection = new McpStdioConnection(config, this.timeoutMs, (reason) => {
      console.error(`[mcp] ${config.name}: ${reason}`);
      this.running.delete(config.name);
      this.unregisterTools(config.name);
      this.failed.set(config.name, reason);
      this.emitStatus();
    });
    try {
      await connection.start();
      const tools = await connection.listTools();
      const registered: string[] = [];
      for (const tool of tools) {
        const name = mcpToolName(config.name, tool.name);
        // Registry dedupe guard: a re-register (restart) should replace, not throw.
        if (toolRegistry.has(name)) toolRegistry.delete(name);
        registerTool({
          name,
          description: `[mcp:${config.name}] ${tool.description ?? "External MCP tool."}`,
          parameters: tool.inputSchema && typeof tool.inputSchema === "object"
            ? tool.inputSchema
            : { type: "object", properties: {} },
        }, async (call) => connection.rawCallTool(call.id, tool.name, call.args));
        registered.push(name);
      }
      this.running.set(config.name, { config, connection, tools: registered });
      console.log(`[mcp] ${config.name}: connected with ${registered.length} tool(s): ${registered.join(", ") || "(none)"}`);
    } catch (error) {
      connection.stop();
      this.failed.set(config.name, errorMessage(error));
      console.error(`[mcp] ${config.name}: ${errorMessage(error)}`);
    }
    this.emitStatus();
  }

  private stopServer(name: string): void {
    const running = this.running.get(name);
    this.running.delete(name);
    this.unregisterTools(name);
    running?.connection.stop();
  }

  startWatching(): void {
    try {
      this.lastMtimeMs = statSync(this.configPath).mtimeMs;
    } catch { this.lastMtimeMs = null; }
    // fs.watch on the parent directory covers create/delete/rename of the file.
    try {
      this.watcher = watch(dirname(this.configPath), { persistent: false }, (_event, filename) => {
        if (filename && filename !== basename(this.configPath)) return;
        this.notePossibleChange();
      });
      this.watcher.on("error", () => { this.watcher = null; });
    } catch {
      this.watcher = null;
    }
    // Fallback + drift guard: cheap mtime poll (a watcher can miss editor
    // atomic-save patterns on some platforms).
    this.pollTimer = setInterval(() => this.notePossibleChange(), 2_000);
    this.pollTimer.unref?.();
  }

  private notePossibleChange(): void {
    let mtime: number | null;
    try {
      mtime = statSync(this.configPath).mtimeMs;
    } catch { mtime = null; }
    if (mtime === this.lastMtimeMs) return;
    this.lastMtimeMs = mtime;
    void this.reload();
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const name of [...this.running.keys()]) this.stopServer(name);
    this.listeners.clear();
  }
}

let manager: McpClientManager | null = null;

/**
 * Start the MCP subsystem: load ~/.forge/mcp.json, spawn every server in it,
 * and broadcast `mcp_status` (via the given function) whenever states change.
 * A no-op when MCP_ENABLED=false.
 */
export function initMcpManager(broadcast: (message: ServerMessage) => void): void {
  if (!mcpEnabled(serverEnv())) {
    console.log("[mcp] disabled via MCP_ENABLED=false");
    return;
  }
  const configPath = mcpConfigPath(serverEnv());
  const timeoutMs = mcpRequestTimeoutMs(serverEnv());
  manager = new McpClientManager(configPath, timeoutMs);
  manager.onStatus((servers) => broadcast({ type: "mcp_status", servers }));
  manager.startWatching();
  void manager.reload().then(() => broadcast({ type: "mcp_status", servers: manager?.statuses() ?? [] }));
  console.log(`[mcp] watching ${configPath}`);
}

export function mcpStatuses(): McpServerStatus[] {
  return manager?.statuses() ?? [];
}

export async function reloadMcpServers(): Promise<McpServerStatus[]> {
  if (!manager) return [];
  await manager.reload();
  return manager.statuses();
}

export async function disposeMcpManager(): Promise<void> {
  const current = manager;
  manager = null;
  await current?.dispose();
}
