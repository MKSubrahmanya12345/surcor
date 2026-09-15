import { timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import {
  clientMessageSchema,
  type AgentMode, type AgentServerConfig, type AgentSocketState, type ChatMessage,
  type ClientMessage, type ServerMessage,
} from "@forge/shared";
import { loadConfig } from "./config";
import { ForgeDatabase } from "./db/client";
import { createProviderRouter } from "./providers/router";
import { runAgentTurn } from "./agent/loop";
import { initIndexService, startIndexing } from "./index/service";
import { validateWorkspaceRoot } from "./tools/paths";
import { configureWebSearch } from "./tools/webSearch";
import { loadWorkspaceRules } from "./agent/rules";
import { disposeMcpManager, initMcpManager, mcpStatuses, reloadMcpServers } from "./mcp/clientManager";
// Prompt 7: CAD mode. The agent server only *connects* to the MAC sidecar (an
// optional local service like Ollama); it never installs or spawns it.
import { loadCadConfig } from "./cad/config";
import { runCadPipeline } from "./cad/pipeline";
import { serveCadArtifact } from "./cad/artifacts";

export function startServer(config: AgentServerConfig = loadConfig()) {
  const provider = createProviderRouter(config);
  const database = new ForgeDatabase(config.databasePath);
  // Prompt 5: codebase index lives in the same SQLite file (schema.sql creates
  // the embeddings/index tables on boot). Tools reach it through index/service.
  initIndexService(database.sqlite, config);
  configureWebSearch(config.webSearch);
  // Prompt 7: CAD mode config (sidecar URL, attempt budget, artifact cache, and
  // which OpenAI-compatible endpoint MAC's four stages should call).
  const cadConfig = loadCadConfig();
  // Persist only non-secret settings. Keys/tokens are read from the environment.
  database.setSetting("provider_order", config.providerOrder);
  database.setSetting("agent_max_turns", config.maxTurns);
  const sockets = new Set<ServerWebSocket<AgentSocketState>>();
  const sessionsInUse = new Set<string>();
  const tasksInFlight = new Set<Promise<void>>();
  let shuttingDown = false;

  // Prompt 6: MCP client — spawns every server in ~/.forge/mcp.json, registers
  // its tools into the shared registry, and re-syncs when the file changes.
  initMcpManager((message) => {
    for (const socket of sockets) emit(socket, message);
  });

  const emit = (socket: ServerWebSocket<AgentSocketState>, message: ServerMessage): void => {
    if (!socket.data.closed && socket.readyState === 1) socket.send(JSON.stringify(message));
  };
  const report = (socket: ServerWebSocket<AgentSocketState>, error: unknown) => {
    emit(socket, { type: "error", message: error instanceof Error ? error.message : "Agent request failed." });
  };
  const historyForClient = (sessionId: string): ChatMessage[] => {
    const messages = database.listMessages(sessionId, 100);
    const history: ChatMessage[] = [];
    let size = 0;
    for (const message of messages.reverse()) {
      size += Buffer.byteLength(JSON.stringify(message));
      if (size > 1_048_576) break;
      history.unshift(message);
    }
    return history;
  };

  const beginTurn = (socket: ServerWebSocket<AgentSocketState>, mode: AgentMode, content: string, planApproved: boolean) => {
    const state = socket.data;
    const session = state.session!;
    const controller = new AbortController();
    database.appendMessage(session.id, { id: crypto.randomUUID(), role: "user", content, mode, createdAt: Date.now() });
    state.activeTurn = controller;
    const task = runAgentTurn({
      workspaceRoot: session.workspaceRoot, sessionId: session.id, database, provider,
      signal: controller.signal, emit: (message) => emit(socket, message), mode, planApproved,
      maxTurns: config.maxTurns, maxToolCallsPerTurn: config.maxToolCallsPerTurn, maxTokens: config.maxTokens,
      commandTimeoutMs: config.commandTimeoutMs, maxFileBytes: config.maxFileBytes, maxOutputBytes: config.maxOutputBytes,
    }).then((planId) => {
      if (planId && !controller.signal.aborted && !state.closed) {
        session.pendingPlanId = planId;
        emit(socket, { type: "plan_ready", messageId: planId });
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) report(socket, error);
    }).finally(() => {
      state.activeTurn = null;
      state.activeTask = null;
      if (state.closed) sessionsInUse.delete(session.id);
    });
    state.activeTask = task;
    tasksInFlight.add(task);
    void task.then(() => tasksInFlight.delete(task), () => tasksInFlight.delete(task));
  };

  /**
   * Prompt 7: a CAD request. Not an agent turn — no provider call, no tool loop,
   * no file writes. Progress and the verdict travel as `cad_*` ServerMessages,
   * and the run occupies the socket's single active turn so the existing
   * `cancel` message aborts it (and aborts the MAC job with it).
   */
  const beginCadTurn = (socket: ServerWebSocket<AgentSocketState>, prompt: string) => {
    const state = socket.data;
    const session = state.session!;
    const controller = new AbortController();
    database.appendMessage(session.id, { id: crypto.randomUUID(), role: "user", content: prompt, mode: "cad", createdAt: Date.now() });
    state.activeTurn = controller;
    const emitCad = (message: ServerMessage): void => {
      // A cancelled run must still be allowed to report why nothing appeared.
      if (!controller.signal.aborted || message.type === "cad_generation_failed") emit(socket, message);
    };
    const task = runCadPipeline({
      prompt, config: cadConfig, emit: emitCad, signal: controller.signal,
      onRawEvent: (event) => {
        const line = typeof event.log === "string" ? event.log : "";
        if (line) console.info(`[forge-cad] ${line.slice(0, 240)}`);
      },
    }).then((outcome) => {
      for (const note of outcome.notes) console.info(`[forge-cad] ${note}`);
      const summary = outcome.result
        ? outcome.result.source === "existing_model"
          ? `CAD: verified existing manufacturer model for "${prompt}".\nSTEP: ${outcome.result.stepPath}\nPreview: ${outcome.result.glbPath}\nSource: ${outcome.result.sourceUrl ?? "unknown"}`
          : `CAD: MAC-generated, QA-verified model for "${prompt}".\nSTEP: ${outcome.result.stepPath}\nPreview: ${outcome.result.glbPath}`
        : `CAD request did not produce a model (${outcome.failure?.stage ?? "unknown"}): ${outcome.failure?.reason ?? "no failure reason reported"}`;
      // Same id in the database row and on the wire, so the summary is in the
      // transcript now and after a reload, with no duplicate.
      const summaryId = crypto.randomUUID();
      if (!state.closed) {
        database.appendMessage(session.id, { id: summaryId, role: "assistant", content: summary, mode: "cad", createdAt: Date.now() });
        if (!controller.signal.aborted) {
          emit(socket, { type: "chat_chunk", messageId: summaryId, delta: summary });
          emit(socket, { type: "chat_done", messageId: summaryId });
        }
      }
      // The pipeline already emitted `cad_generation_failed` for every refusal;
      // this only covers a result-less, failure-less return, which should not
      // happen but must not leave the panel spinning either.
      if (!outcome.result && !outcome.failure) {
        emitCad({ type: "cad_generation_failed", failure: { reason: "CAD pipeline stopped without a result or a reason.", stage: "qa_pass" } });
      }
    }).catch((error: unknown) => {
      const reason = controller.signal.aborted
        ? "Cancelled before the CAD pipeline could finish."
        : `CAD pipeline error: ${error instanceof Error ? error.message : "unknown error"}`;
      emitCad({ type: "cad_generation_failed", failure: { reason, stage: controller.signal.aborted ? "qa_pass" : "spec_planning" } });
      if (!controller.signal.aborted) console.error(`[forge-cad] ${reason}`);
    }).finally(() => {
      state.activeTurn = null;
      state.activeTask = null;
      if (state.closed) sessionsInUse.delete(session.id);
    });
    state.activeTask = task;
    tasksInFlight.add(task);
    void task.then(() => tasksInFlight.delete(task), () => tasksInFlight.delete(task));
  };

  const handle = async (socket: ServerWebSocket<AgentSocketState>, message: ClientMessage): Promise<void> => {
    const state = socket.data;
    if (state.closed || shuttingDown) return;
    if (message.type === "init") {
      if (state.session || state.initializing) throw new Error("This connection is already initialized.");
      state.initializing = true;
      try {
        const root = await validateWorkspaceRoot(message.workspaceRoot);
        if (state.closed) return;
        const session = database.openSession(root, message.sessionId);
        if (sessionsInUse.has(session.id)) throw new Error("Session is already connected in another window.");
        sessionsInUse.add(session.id);
        state.session = session;
        // Background index build; progress goes to this console, never to the client.
        startIndexing(root);
        // Prompt 6: read .forge/rules.md once per connection and cache it for
        // agent/loop.ts to prepend to every system message of this session.
        try {
          const rules = await loadWorkspaceRules(root);
          database.setSetting(`workspace_rules:${session.id}`, rules);
        } catch (error) {
          console.error(`[forge-agent] Could not load .forge/rules.md: ${error instanceof Error ? error.message : error}`);
          database.setSetting(`workspace_rules:${session.id}`, null);
        }
        const history = historyForClient(session.id);
        if (session.pendingPlanId && !history.some((message) => message.id === session.pendingPlanId)) {
          const plan = database.getMessage(session.id, session.pendingPlanId);
          if (plan) history.unshift(plan);
        }
        emit(socket, { type: "session_ready", sessionId: session.id, workspaceRoot: root,
          history, pendingDiffs: database.listPendingDiffs(session.id),
          ...(session.pendingPlanId ? { pendingPlanId: session.pendingPlanId } : {}) });
      } finally { state.initializing = false; }
      return;
    }
    // Prompt 6: MCP status is server-global, not session-bound, so these work
    // before init as well.
    if (message.type === "mcp_status_request") {
      emit(socket, { type: "mcp_status", servers: mcpStatuses() });
      return;
    }
    if (message.type === "mcp_reload") {
      const servers = await reloadMcpServers();
      emit(socket, { type: "mcp_status", servers });
      return;
    }
    const session = state.session;
    if (!session) throw new Error("Send init with workspaceRoot before other messages.");
    // Prompt 7: CAD mode. Shares the one-active-turn slot with agent turns, so a
    // running generation blocks (and is blocked by) a chat turn, and `cancel`
    // below stops whichever is in flight.
    if (message.type === "cad_generate") {
      if (state.activeTurn) throw new Error("A turn is already running. Send cancel before starting another.");
      beginCadTurn(socket, message.prompt.trim());
      return;
    }
    if (message.type === "cancel") {
      state.activeTurn?.abort(new Error("Request cancelled."));
      session.pendingPlanId = null;
      database.setPendingPlan(session.id, null);
      return;
    }
    if (message.type === "diff_decision") {
      const diff = database.decideDiff(session.id, message.diffId, message.decision);
      const recordDecision = () => database.appendMessage(session.id, {
        id: crypto.randomUUID(), role: "user", mode: "agent", createdAt: Date.now(),
        content: `The client ${diff.status} diff ${diff.id} for ${diff.filePath}. This records review only; the client, not this server, is responsible for applying accepted content.`,
      });
      // Do not insert a user message between a provider's tool calls/results.
      if (state.activeTask) void state.activeTask.then(recordDecision).catch((error: unknown) => report(socket, error));
      else recordDecision();
      return;
    }
    if (state.activeTurn) throw new Error("A turn is already running. Send cancel before starting another.");
    if (message.type === "approve_plan") {
      if (!session.pendingPlanId) throw new Error("There is no plan awaiting approval.");
      const planId = session.pendingPlanId;
      const plan = database.getMessage(session.id, planId);
      if (!plan || plan.role !== "assistant" || plan.mode !== "plan") throw new Error("The pending plan could not be restored. Request a new plan.");
      // Include the exact persisted plan even if intervening Q&A pushed it out
      // of the rolling provider context. Approval text is never inferred by an LLM.
      beginTurn(socket, "plan", `I explicitly approve plan ${planId}. Execute this approved plan:\n${plan.content}`, true);
      session.pendingPlanId = null;
      database.setPendingPlan(session.id, null);
      return;
    }
    if (message.type === "user_message") {
      if (session.pendingPlanId && message.mode === "agent") {
        throw new Error("A plan is awaiting approval. Send approve_plan to execute it, a plan-mode message to revise it, or cancel to discard it.");
      }
      if (message.mode === "plan") {
        session.pendingPlanId = null;
        database.setPendingPlan(session.id, null);
      }
      // Ask may discuss a pending plan, but cannot approve or execute it.
      beginTurn(socket, message.mode, message.content, false);
    }
  };

  const authorize = (request: Request): boolean => {
    const url = new URL(request.url);
    if (config.token) {
      // Browser WebSockets cannot set Authorization, so an optional token query
      // parameter is supported. Never log request URLs or the token.
      const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";
      const expected = Buffer.from(config.token);
      const actual = Buffer.from(supplied);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    }
    // Reject DNS rebinding and arbitrary web origins. Raw local WS clients have
    // no Origin. Packaged file:// renderers should use FORGE_SERVER_TOKEN, or
    // explicitly opt into ALLOWED_ORIGINS=null in trusted local development.
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return false;
    const origin = request.headers.get("origin");
    if (!origin || config.allowedOrigins.includes(origin)) return true;
    try {
      const parsed = new URL(origin);
      return ["http:", "https:"].includes(parsed.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    } catch { return false; }
  };

  const server = Bun.serve<AgentSocketState>({
    hostname: config.hostname,
    port: config.port,
    fetch(request, server) {
      if (shuttingDown) return new Response("Shutting down", { status: 503 });
      if (!authorize(request)) return new Response("Forbidden", { status: 403 });
      const path = new URL(request.url).pathname;
      if (path === "/health") return Response.json({ ok: true, service: "forge-agent" });
      // Prompt 7: read-only access to Forge's own CAD cache (verified STEP/GLB/STL
      // for <model-viewer> and the Download buttons). Paths outside that
      // directory are refused by the handler, not by this route list.
      if (path === "/cad/artifact") return serveCadArtifact(request, cadConfig, config.token);
      if (path !== "/" && path !== "/ws") return new Response("Not found", { status: 404 });
      if (server.upgrade(request, { data: {
        session: null, initializing: false, closed: false, activeTurn: null, activeTask: null, queue: Promise.resolve(), queuedMessages: 0,
      } })) return;
      return new Response("WebSocket upgrade required", { status: 426 });
    },
    websocket: {
      maxPayloadLength: 1_048_576,
      idleTimeout: 0,
      backpressureLimit: 32 * 1_048_576,
      closeOnBackpressureLimit: true,
      open(socket) { sockets.add(socket); },
      message(socket, raw) {
        let message: ClientMessage;
        try {
          const parsed = clientMessageSchema.safeParse(JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)));
          if (!parsed.success) throw new Error("Invalid ClientMessage payload.");
          message = parsed.data;
        } catch { report(socket, new Error("Invalid ClientMessage: expected a valid JSON protocol message.")); return; }
        // Serialize init/state changes, but never await a whole agent turn here:
        // cancel and diff decisions must remain responsive during streaming.
        if (socket.data.queuedMessages >= 32) {
          socket.close(1008, "Too many queued messages");
          return;
        }
        socket.data.queuedMessages++;
        socket.data.queue = socket.data.queue.then(() => handle(socket, message))
          .catch((error: unknown) => report(socket, error))
          .finally(() => { socket.data.queuedMessages--; });
      },
      close(socket) {
        const state = socket.data;
        state.closed = true;
        state.activeTurn?.abort(new Error("Client disconnected."));
        if (state.session && !state.activeTask) sessionsInUse.delete(state.session.id);
        sockets.delete(socket);
      },
    },
  });

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const socket of sockets) {
      socket.data.closed = true;
      socket.data.activeTurn?.abort(new Error("Server shutting down."));
      socket.close(1001, "Server shutting down");
    }
    await server.stop(true);
    // Include turns from recently disconnected sockets until cancellation has
    // finished recording their tool results; never close SQLite underneath them.
    await Promise.allSettled([...tasksInFlight]);
    await disposeMcpManager();
    database.close();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
  const onSignal = () => { void shutdown().catch(() => process.exit(1)); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  console.info(`[forge-agent] Listening on ws://${config.hostname.includes(":") ? `[${config.hostname}]` : config.hostname}:${server.port}`);
  return { server, database, shutdown };
}

if (import.meta.main) {
  try { startServer(); }
  catch (error) {
    console.error(`[forge-agent] ${error instanceof Error ? error.message : "Startup failed."}`);
    process.exitCode = 1;
  }
}
