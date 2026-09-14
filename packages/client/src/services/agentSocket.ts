import type { ClientMessage, ServerMessage } from "@forge/shared";

export type AgentConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

type MessageListener = (message: ServerMessage) => void;
type StatusListener = (status: AgentConnectionStatus) => void;

const DEFAULT_URL = "ws://localhost:4500";
const RECONNECT_MAX_MS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sessionKey = (workspaceRoot: string): string => `forge.agent.session.${workspaceRoot}`;

const configuredUrl = (): string => {
  const value = import.meta.env.VITE_FORGE_AGENT_URL as string | undefined;
  return value && value.trim() ? value.trim() : DEFAULT_URL;
};

const configuredToken = (): string | undefined => {
  const value = import.meta.env.VITE_FORGE_AGENT_TOKEN as string | undefined;
  return value && value.trim() ? value.trim() : undefined;
};

/**
 * Singleton WebSocket client for the Prompt 3 agent server. This is the ONLY
 * file in the renderer allowed to open a WebSocket to the agent server —
 * everything else subscribes to its emitter (see stores/useChatStore.ts).
 *
 * The socket opens on launch; the protocol-level `init` is deferred until a
 * workspace root is known (the server requires it). Switching workspaces
 * reconnects cleanly, because one connection is bound to one session.
 */
class AgentSocket {
  private socket: WebSocket | null = null;
  private workspaceRoot: string | null = null;
  private initialized = false;
  private status: AgentConnectionStatus = "disconnected";
  private reconnectTimer: number | null = null;
  private attempts = 0;
  private retriedWithoutSession = false;
  private messageListeners = new Set<MessageListener>();
  private statusListeners = new Set<StatusListener>();

  get connectionStatus(): AgentConnectionStatus {
    return this.status;
  }

  /** Open the socket (idempotent). Safe to call on app launch. */
  connect(): void {
    this.openIfIdle();
  }

  /**
   * Bind the connection to a workspace. Sends `init` immediately when the
   * socket is open, or remembers the root so the next (re)connect inits.
   * Changing to a different root reconnects: sessions are workspace-bound.
   */
  setWorkspaceRoot(root: string | null): void {
    if (this.workspaceRoot === root) return;
    const previous = this.workspaceRoot;
    this.workspaceRoot = root;
    this.retriedWithoutSession = false;
    if (!root) return;
    if (previous && this.initialized) {
      this.teardown();
      this.openIfIdle();
      return;
    }
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.sendInit();
    else this.openIfIdle();
  }

  /** Send a ClientMessage. Returns false when the connection is not usable. */
  send(message: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.initialized) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => { this.messageListeners.delete(listener); };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => { this.statusListeners.delete(listener); };
  }

  private setStatus(status: AgentConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private openIfIdle(): void {
    if (this.socket || this.reconnectTimer !== null) return;
    this.setStatus(this.attempts > 0 ? "reconnecting" : "connecting");
    let socket: WebSocket;
    try {
      const url = new URL(configuredUrl());
      const token = configuredToken();
      if (token) url.searchParams.set("token", token);
      socket = new WebSocket(url.toString());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
      this.setStatus("connected");
      if (this.workspaceRoot) this.sendInit();
    };
    socket.onmessage = (event: MessageEvent) => this.handleRaw(event.data);
    socket.onclose = () => {
      this.socket = null;
      this.initialized = false;
      this.scheduleReconnect();
    };
    socket.onerror = () => { /* the close handler drives recovery */ };
  }

  /** Close without handlers firing; used when switching workspaces. */
  private teardown(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.initialized = false;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      if (socket.readyState <= WebSocket.OPEN) socket.close();
    }
    this.attempts = 0;
  }

  private scheduleReconnect(): void {
    this.initialized = false;
    this.setStatus("reconnecting");
    const delay = Math.min(RECONNECT_MAX_MS, 500 * 2 ** Math.min(this.attempts, 5));
    this.attempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openIfIdle();
    }, delay);
  }

  private sendInit(): void {
    const root = this.workspaceRoot;
    if (!root || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    let sessionId: string | null = null;
    try {
      sessionId = localStorage.getItem(sessionKey(root));
    } catch { /* storage unavailable: start a fresh session */ }
    const init: ClientMessage = sessionId && UUID_PATTERN.test(sessionId)
      ? { type: "init", workspaceRoot: root, sessionId }
      : { type: "init", workspaceRoot: root };
    this.socket.send(JSON.stringify(init));
  }

  private handleRaw(raw: unknown): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : String(raw)) as ServerMessage;
    } catch {
      return;
    }
    if (!message || typeof (message as { type?: unknown }).type !== "string") return;

    if (message.type === "session_ready") {
      this.initialized = true;
      this.retriedWithoutSession = false;
      if (this.workspaceRoot) {
        try {
          localStorage.setItem(sessionKey(this.workspaceRoot), message.sessionId);
        } catch { /* non-fatal */ }
      }
    } else if (
      message.type === "error" &&
      !this.initialized &&
      !this.retriedWithoutSession &&
      /session/i.test(message.message)
    ) {
      // A stored session id no longer matches this workspace (e.g. the server
      // database was reset). Drop it and reconnect with a fresh session.
      this.retriedWithoutSession = true;
      if (this.workspaceRoot) {
        try {
          localStorage.removeItem(sessionKey(this.workspaceRoot));
        } catch { /* non-fatal */ }
      }
      this.teardown();
      this.openIfIdle();
    }

    for (const listener of this.messageListeners) listener(message);
  }
}

export const agentSocket = new AgentSocket();
