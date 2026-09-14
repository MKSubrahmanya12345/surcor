export interface FileNode {
  path: string;            // absolute path
  name: string;
  isDirectory: boolean;
  children?: FileNode[];   // present only if isDirectory and expanded
}

export interface OpenTab {
  id: string;              // uuid
  filePath: string;
  isDirty: boolean;
  language: string;        // monaco language id
}

export type AgentMode = "ask" | "agent" | "plan";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  mode: AgentMode;
  toolCalls?: ToolCall[];
  createdAt: number;
}

export interface ToolCall {
  id: string;
  name: string;            // e.g. "read_file", "write_file", "run_terminal_command"
  args: Record<string, unknown>;
  result?: ToolResult;
}

export interface ToolResult {
  toolCallId: string;
  ok: boolean;
  output: string;
  error?: string;
}

export interface DiffProposal {
  id: string;
  filePath: string;
  originalContent: string;
  proposedContent: string;
  status: "pending" | "accepted" | "rejected";
}

export interface Checkpoint {
  id: string;
  createdAt: number;
  label: string;
  fileSnapshots: { filePath: string; content: string }[];
}

// WebSocket message envelope between client and the Bun agent server
// (server is introduced in Prompt 3 — define the envelope now so Prompt 1's
// IPC layer and Prompt 3's server agree on shape without ever talking to
// each other directly)
export type ServerMessage =
  | { type: "chat_chunk"; messageId: string; delta: string }
  | { type: "chat_done"; messageId: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "tool_result"; result: ToolResult }
  | { type: "diff_proposed"; diff: DiffProposal }
  | { type: "error"; message: string };

export type ClientMessage =
  | { type: "user_message"; content: string; mode: AgentMode }
  | { type: "diff_decision"; diffId: string; decision: "accept" | "reject" }
  | { type: "cancel" };
