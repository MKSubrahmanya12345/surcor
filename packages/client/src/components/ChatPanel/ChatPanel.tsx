import { useEffect, useRef, useState } from "react";
import type { AgentMode, ChatMessage } from "@forge/shared";
import { agentSocket } from "../../services/agentSocket";
import { useChatStore } from "../../stores/useChatStore";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { CheckpointBar } from "../CheckpointBar/CheckpointBar";
import { DiffReview } from "../DiffReview/DiffReview";
import { PlanApproval } from "../PlanApproval/PlanApproval";
import { FOCUS_CHAT_EVENT } from "../CommandPalette/CommandPalette";
import { renderMarkdown } from "./markdown";

const MODES: { id: AgentMode; label: string }[] = [
  { id: "ask", label: "Ask" },
  { id: "agent", label: "Agent" },
  { id: "plan", label: "Plan" },
];

const toolSummary = (message: ChatMessage): string => {
  const call = message.toolCalls?.[0];
  if (!call) return "";
  const args = call.args as Record<string, unknown>;
  const subject = typeof args.path === "string"
    ? args.path
    : typeof args.command === "string"
      ? args.command
      // Search tools have no path/command: show what was searched for.
      : typeof args.query === "string"
        ? args.query
        : "";
  return `used tool: ${call.name}${subject ? `(${subject})` : ""}`;
};

function ToolLine({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const call = message.toolCalls?.[0];
  if (!call) return null;
  const result = call.result;
  return (
    <div className="chat-tool">
      <button
        type="button"
        className="chat-tool-summary"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="chat-tool-chevron">{expanded ? "▾" : "▸"}</span>
        <span className="chat-tool-label">{toolSummary(message)}</span>
        {!result && <span className="chat-tool-running" title="Running…">…</span>}
        {result && (result.ok
          ? <span className="chat-tool-ok" title="Succeeded">✓</span>
          : <span className="chat-tool-err" title={result.error ?? "Failed"}>✗</span>)}
      </button>
      {expanded && (
        <pre className="chat-tool-output">
          {result
            ? (result.error ? `${result.error}${result.output ? `\n${result.output}` : ""}` : (result.output || "(no output)"))
            : `arguments:\n${JSON.stringify(call.args, null, 2)}`}
        </pre>
      )}
    </div>
  );
}

export function ChatPanel() {
  const connection = useChatStore((state) => state.connection);
  const ready = useChatStore((state) => state.ready);
  const busy = useChatStore((state) => state.busy);
  const mode = useChatStore((state) => state.mode);
  const setMode = useChatStore((state) => state.setMode);
  const messages = useChatStore((state) => state.messages);
  const pendingPlanId = useChatStore((state) => state.pendingPlanId);
  const serverError = useChatStore((state) => state.serverError);
  const clearServerError = useChatStore((state) => state.clearServerError);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const cancelTurn = useChatStore((state) => state.cancelTurn);
  const resetForWorkspace = useChatStore((state) => state.resetForWorkspace);

  const folderPath = useWorkspaceStore((state) => state.folderPath);
  const openFolder = useWorkspaceStore((state) => state.openFolder);

  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Connect on launch; bind the session to the open workspace.
  useEffect(() => {
    agentSocket.connect();
  }, []);
  useEffect(() => {
    if (folderPath) {
      resetForWorkspace();
      agentSocket.setWorkspaceRoot(folderPath);
    } else {
      agentSocket.setWorkspaceRoot(null);
    }
  }, [folderPath, resetForWorkspace]);

  useEffect(() => {
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, busy]);

  // Ctrl/Cmd+L and the command palette's "Focus Chat Input" land here.
  useEffect(() => {
    const focusInput = () => inputRef.current?.focus();
    window.addEventListener(FOCUS_CHAT_EVENT, focusInput);
    return () => window.removeEventListener(FOCUS_CHAT_EVENT, focusInput);
  }, []);

  const submit = (): void => {
    const text = draft.trim();
    if (!text || busy || !ready) return;
    sendMessage(text);
    setDraft("");
  };

  const editPlan = (): void => {
    setMode("plan");
    setDraft("Revise the plan: ");
    inputRef.current?.focus();
  };

  const statusDot = ready || connection === "connected" ? "ok" : connection === "disconnected" ? "err" : "warn";
  const statusText = ready
    ? `connected · ${mode} mode`
    : connection === "connected"
      ? "waiting for session…"
      : connection === "connecting"
        ? "connecting to agent server…"
        : connection === "reconnecting"
          ? "reconnecting to agent server…"
          : "agent server unreachable";

  const lastMessage = messages[messages.length - 1];
  const waitingForReply = busy && (!lastMessage || lastMessage.role === "user");

  return (
    <section className="chat-panel" aria-label="Forge chat">
      <header className="chat-header">
        <span className={`chat-status-dot ${statusDot}`} aria-hidden="true" />
        <span className="chat-header-title">Chat</span>
        <span className="chat-status-text">{statusText}</span>
      </header>

      {!folderPath ? (
        <div className="chat-empty">
          <p>Open a folder to start chatting with the Forge agent.</p>
          <button type="button" className="primary-button" onClick={() => void openFolder()}>
            Open Folder
          </button>
        </div>
      ) : (
        <>
          <div className="chat-messages" ref={listRef}>
            {messages.length === 0 && (
              <div className="chat-empty">
                <p>
                  Ask questions about the workspace (<strong>Ask</strong>), let the agent read and
                  edit files (<strong>Agent</strong>), or request a numbered plan first (<strong>Plan</strong>).
                </p>
                {!ready && (
                  <p className="chat-hint">
                    {connection === "disconnected"
                      ? "Start the agent server with: bun run packages/server/src/server.ts"
                      : "Connecting to the agent server…"}
                  </p>
                )}
              </div>
            )}
            {messages.map((message) => {
              if (message.role === "tool") return <ToolLine key={message.id} message={message} />;
              return (
                <div key={message.id} className={`chat-message ${message.role}`}>
                  <div className="chat-message-role">
                    {message.role === "user" ? "You" : "Forge"}
                    <span className="chat-message-mode">{message.mode}</span>
                  </div>
                  <div className="chat-message-content">
                    {message.content ? renderMarkdown(message.content) : "…"}
                  </div>
                  {message.id === pendingPlanId && <PlanApproval onEdit={editPlan} />}
                </div>
              );
            })}
            {waitingForReply && <div className="chat-busy">Forge is thinking…</div>}
          </div>

          <DiffReview />
          <CheckpointBar />

          {serverError && (
            <p className="chat-server-error" role="alert">
              <span>{serverError}</span>
              <button type="button" onClick={clearServerError} aria-label="Dismiss error">×</button>
            </p>
          )}

          <div className="chat-composer">
            <div className="chat-modes" role="group" aria-label="Agent mode">
              {MODES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`chat-mode ${mode === item.id ? "active" : ""}`}
                  aria-pressed={mode === item.id}
                  onClick={() => setMode(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <textarea
              ref={inputRef}
              className="chat-input"
              placeholder={ready ? "Describe what you want Forge to do…" : "Waiting for the agent server…"}
              value={draft}
              disabled={!ready}
              rows={3}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <div className="chat-send-row">
              <span className="chat-hint">
                {pendingPlanId && mode === "agent"
                  ? "A plan awaits approval — approve it, or switch to Plan mode to revise."
                  : "Enter to send · Shift+Enter for a new line"}
              </span>
              {busy ? (
                <button type="button" className="secondary-button chat-send" onClick={cancelTurn}>
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  className="primary-button chat-send"
                  disabled={!ready || !draft.trim()}
                  onClick={submit}
                >
                  Send
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
