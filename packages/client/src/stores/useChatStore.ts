import { create } from "zustand";
import type {
  AgentMode,
  ChatMessage,
  Checkpoint,
  DiffProposal,
  McpServerStatus,
  ServerMessage,
  ToolResult,
} from "@forge/shared";
import { agentSocket, type AgentConnectionStatus } from "../services/agentSocket";
import { useWorkspaceStore } from "./useWorkspaceStore";

// Tools that mutate the workspace. The first one in a turn triggers a
// client-side checkpoint of every file currently open in a tab.
const WRITE_TOOLS = new Set(["write_file", "apply_diff"]);

const CHECKPOINT_CAP = 25;
const MAX_SNAPSHOT_CHARS = 512 * 1024;

const checkpointsKey = (workspaceRoot: string): string => `forge.checkpoints.${workspaceRoot}`;

function loadCheckpoints(workspaceRoot: string): Checkpoint[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(checkpointsKey(workspaceRoot)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is Checkpoint =>
        Boolean(item) &&
        typeof (item as Checkpoint).id === "string" &&
        typeof (item as Checkpoint).createdAt === "number" &&
        typeof (item as Checkpoint).label === "string" &&
        Array.isArray((item as Checkpoint).fileSnapshots),
    );
  } catch {
    return [];
  }
}

function saveCheckpoints(workspaceRoot: string, checkpoints: Checkpoint[]): void {
  try {
    localStorage.setItem(checkpointsKey(workspaceRoot), JSON.stringify(checkpoints));
  } catch {
    // Storage full/unavailable: checkpoints stay in memory for this run.
  }
}

/** Attach a final ToolResult to the tool message owning that call id. */
function withResult(messages: ChatMessage[], result: ToolResult): ChatMessage[] {
  const index = messages.findIndex((message) =>
    message.role === "tool" && message.toolCalls?.some((call) => call.id === result.toolCallId));
  if (index < 0) return messages;
  const message = messages[index];
  const toolCalls = (message.toolCalls ?? []).map((call) =>
    call.id === result.toolCallId ? { ...call, result } : call);
  const next = messages.slice();
  next[index] = { ...message, toolCalls };
  return next;
}

/** Append a streamed chunk to the in-progress result of a running tool call. */
function withResultChunk(messages: ChatMessage[], chunk: ToolResult): ChatMessage[] {
  const index = messages.findIndex((message) =>
    message.role === "tool" && message.toolCalls?.some((call) => call.id === chunk.toolCallId));
  if (index < 0) return messages;
  const message = messages[index];
  const toolCalls = (message.toolCalls ?? []).map((call) => {
    if (call.id !== chunk.toolCallId) return call;
    const existing = call.result;
    return {
      ...call,
      result: existing
        ? { ...existing, output: existing.output + chunk.output }
        : { ...chunk, ok: true },
    };
  });
  const next = messages.slice();
  next[index] = { ...message, toolCalls };
  return next;
}

interface ChatState {
  connection: AgentConnectionStatus;
  /** true once the server answered init with session_ready */
  ready: boolean;
  /** true while a server turn (streaming / tool execution) is in flight */
  busy: boolean;
  mode: AgentMode;
  messages: ChatMessage[];
  pendingDiffs: DiffProposal[];
  pendingPlanId: string | null;
  checkpoints: Checkpoint[];
  serverError: string | null;
  /** Prompt 6: live MCP server states pushed by the agent server. */
  mcpServers: McpServerStatus[];
  setMode: (mode: AgentMode) => void;
  sendMessage: (content: string) => void;
  cancelTurn: () => void;
  approvePlan: () => void;
  decideDiff: (diffId: string, decision: "accept" | "reject") => Promise<void>;
  restoreLastCheckpoint: () => Promise<void>;
  clearServerError: () => void;
  resetForWorkspace: () => void;
}

// One checkpoint per turn: armed on send/approve, consumed by the first
// write-type tool_call seen from the server.
let turnCheckpointTaken = false;

function snapshotOpenFiles(label: string, checkpoints: Checkpoint[]): Checkpoint[] {
  const workspaceRoot = useWorkspaceStore.getState().folderPath;
  if (!workspaceRoot) return checkpoints;
  const { openTabs, contents } = useWorkspaceStore.getState();
  const seen = new Set<string>();
  const fileSnapshots: { filePath: string; content: string }[] = [];
  for (const tab of openTabs) {
    if (seen.has(tab.filePath)) continue;
    const content = contents[tab.id];
    if (typeof content !== "string" || content.length > MAX_SNAPSHOT_CHARS) continue;
    seen.add(tab.filePath);
    fileSnapshots.push({ filePath: tab.filePath, content });
  }
  if (!fileSnapshots.length) return checkpoints;
  const checkpoint: Checkpoint = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    label,
    fileSnapshots,
  };
  return [...checkpoints, checkpoint].slice(-CHECKPOINT_CAP);
}

export const useChatStore = create<ChatState>()((set, get) => ({
  connection: agentSocket.connectionStatus,
  ready: false,
  busy: false,
  mode: "agent",
  messages: [],
  pendingDiffs: [],
  pendingPlanId: null,
  checkpoints: [],
  serverError: null,
  mcpServers: [],

  setMode: (mode) => set({ mode }),

  sendMessage: (content) => {
    const text = content.trim();
    if (!text) return;
    const state = get();
    if (!state.ready || state.busy) return;
    if (state.pendingPlanId && state.mode === "agent") {
      set({
        serverError:
          "A plan is awaiting approval. Approve it, switch to Plan mode to revise it, or cancel it first.",
      });
      return;
    }
    const sent = agentSocket.send({ type: "user_message", content: text, mode: state.mode });
    if (!sent) {
      set({ serverError: "Not connected to the agent server." });
      return;
    }
    turnCheckpointTaken = false;
    set((current) => ({
      messages: [
        ...current.messages,
        { id: crypto.randomUUID(), role: "user", content: text, mode: current.mode, createdAt: Date.now() },
      ],
      busy: true,
      serverError: null,
      // A plan-mode message supersedes any pending plan on the server.
      ...(current.mode === "plan" && current.pendingPlanId ? { pendingPlanId: null } : {}),
    }));
  },

  cancelTurn: () => {
    if (!agentSocket.send({ type: "cancel" })) return;
    turnCheckpointTaken = false;
    set({ busy: false, pendingPlanId: null });
  },

  approvePlan: () => {
    const state = get();
    if (!state.pendingPlanId || state.busy || !state.ready) return;
    if (!agentSocket.send({ type: "approve_plan" })) return;
    turnCheckpointTaken = false;
    set({ pendingPlanId: null, busy: true, serverError: null });
  },

  decideDiff: async (diffId, decision) => {
    const diff = get().pendingDiffs.find((item) => item.id === diffId);
    if (!diff) return;
    if (decision === "accept") {
      // The ONLY file-write path is Prompt 1's fs:writeFile IPC handler.
      try {
        await window.forge.writeFile(diff.filePath, diff.proposedContent);
      } catch (error) {
        set({
          serverError: `Could not write ${diff.filePath}: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      useWorkspaceStore.getState().applyExternalFileContent(diff.filePath, diff.proposedContent);
    }
    agentSocket.send({ type: "diff_decision", diffId, decision });
    set((current) => ({ pendingDiffs: current.pendingDiffs.filter((item) => item.id !== diffId) }));
  },

  restoreLastCheckpoint: async () => {
    const workspaceRoot = useWorkspaceStore.getState().folderPath;
    const { checkpoints } = get();
    const checkpoint = checkpoints[checkpoints.length - 1];
    if (!checkpoint || !workspaceRoot) return;
    try {
      for (const snapshot of checkpoint.fileSnapshots) {
        await window.forge.writeFile(snapshot.filePath, snapshot.content);
        useWorkspaceStore.getState().applyExternalFileContent(snapshot.filePath, snapshot.content);
      }
    } catch (error) {
      set({
        serverError: `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    const remaining = checkpoints.slice(0, -1);
    set({ checkpoints: remaining });
    saveCheckpoints(workspaceRoot, remaining);
  },

  clearServerError: () => set({ serverError: null }),

  resetForWorkspace: () => {
    turnCheckpointTaken = false;
    set({
      ready: false,
      busy: false,
      messages: [],
      pendingDiffs: [],
      pendingPlanId: null,
      checkpoints: [],
      serverError: null,
    });
  },
}));

function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case "session_ready":
      turnCheckpointTaken = false;
      useChatStore.setState({
        ready: true,
        busy: false,
        messages: message.history,
        pendingDiffs: message.pendingDiffs,
        pendingPlanId: message.pendingPlanId ?? null,
        checkpoints: loadCheckpoints(message.workspaceRoot),
        serverError: null,
      });
      // Prompt 6: the socket is initialized now, so the current MCP server
      // states can be pulled once; later changes arrive as broadcasts.
      agentSocket.send({ type: "mcp_status_request" });
      return;
    case "mcp_status":
      useChatStore.setState({ mcpServers: message.servers });
      return;
    case "chat_chunk":
      useChatStore.setState((current) => {
        const index = current.messages.findIndex((item) => item.id === message.messageId);
        if (index < 0) {
          return {
            messages: [
              ...current.messages,
              { id: message.messageId, role: "assistant", content: message.delta, mode: current.mode, createdAt: Date.now() },
            ],
          };
        }
        const messages = current.messages.slice();
        messages[index] = { ...messages[index], content: messages[index].content + message.delta };
        return { messages };
      });
      return;
    case "chat_reset":
      useChatStore.setState((current) => ({
        messages: current.messages.map((item) =>
          item.id === message.messageId ? { ...item, content: "" } : item),
      }));
      return;
    case "chat_done":
      turnCheckpointTaken = false;
      useChatStore.setState({ busy: false });
      return;
    case "tool_call": {
      const call = message.toolCall;
      useChatStore.setState((current) => {
        let checkpoints = current.checkpoints;
        if (!turnCheckpointTaken && WRITE_TOOLS.has(call.name)) {
          checkpoints = snapshotOpenFiles(`Before ${call.name}`, checkpoints);
          turnCheckpointTaken = true;
          const workspaceRoot = useWorkspaceStore.getState().folderPath;
          if (workspaceRoot) saveCheckpoints(workspaceRoot, checkpoints);
        }
        return {
          busy: true,
          checkpoints,
          messages: [
            ...current.messages,
            {
              id: crypto.randomUUID(),
              role: "tool",
              content: "",
              mode: current.mode,
              toolCalls: [{ ...call }],
              createdAt: Date.now(),
            },
          ],
        };
      });
      return;
    }
    case "tool_result":
      useChatStore.setState((current) => ({ messages: withResult(current.messages, message.result) }));
      return;
    case "tool_result_chunk":
      useChatStore.setState((current) => ({ messages: withResultChunk(current.messages, message.result) }));
      return;
    case "diff_proposed":
      useChatStore.setState((current) =>
        current.pendingDiffs.some((item) => item.id === message.diff.id)
          ? {}
          : { pendingDiffs: [...current.pendingDiffs, message.diff] });
      return;
    case "plan_ready":
      useChatStore.setState({ pendingPlanId: message.messageId });
      return;
    case "error":
      useChatStore.setState({ serverError: message.message, busy: false });
      return;
  }
}

agentSocket.onMessage(handleServerMessage);
agentSocket.onStatus((connection) => {
  useChatStore.setState(
    connection === "connected" ? { connection } : { connection, ready: false },
  );
});
