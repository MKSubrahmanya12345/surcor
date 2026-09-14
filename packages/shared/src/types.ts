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

// ---------------------------------------------------------------------------
// Terminal (Prompt 2)
// ---------------------------------------------------------------------------

export interface TerminalSessionInfo {
  id: string;       // pty session id, stable for the lifetime of the shell
  shell: string;    // resolved absolute path of the shell binary
  cwd: string;      // working directory the shell was spawned in
}

export interface TerminalTab {
  id: string;       // matches the pty session id
  title: string;    // e.g. "zsh", "bash (exited)"
  shell: string;
  cwd: string;
  exited: boolean;
}

// ---------------------------------------------------------------------------
// Git (Prompt 2)
// ---------------------------------------------------------------------------

export type GitFileStatusCode =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "unmerged"
  | "unknown";

export interface GitFileStatus {
  path: string;                 // repo-relative path
  absolutePath: string;         // absolute path on disk
  status: GitFileStatusCode;    // resolved status of this entry
  indexStatus: string;          // raw porcelain code for the index, " " when clean
  workingDirStatus: string;     // raw porcelain code for the worktree, " " when clean
  staged: boolean;              // true = index entry, false = worktree entry
  renamedFrom?: string;         // previous path when status is "renamed"
}

export interface GitStatusSummary {
  isRepository: boolean;
  repoPath: string;
  branch: string | null;
  detached: boolean;
  tracking: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

export interface GitDiff {
  filePath: string;             // repo-relative path
  absolutePath: string;
  staged: boolean;              // diff of the index vs HEAD when true
  isUntracked: boolean;         // brand new file, nothing to compare against
  isBinary: boolean;            // contents are not shown for binary files
  original: string;
  modified: string;
  truncated: boolean;           // contents were capped by the size limit
}

export interface GitBranchInfo {
  isRepository: boolean;
  branch: string | null;
  detached: boolean;
  branches: string[];
  tracking: string | null;
  ahead: number;
  behind: number;
}

export interface GitOperationResult {
  ok: boolean;
  message: string;
}

export interface GitCloneResult extends GitOperationResult {
  repoPath: string;   // absolute path of the freshly cloned working copy
}

// ---------------------------------------------------------------------------
// GitHub (Prompt 2)
// ---------------------------------------------------------------------------

export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  cloneUrl: string;
  htmlUrl: string;
  description: string | null;
  defaultBranch: string | null;
  updatedAt: string | null;
  language: string | null;
}

export type DeviceAuthStatus = "idle" | "pending" | "polling" | "success" | "error";

export interface DeviceAuthState {
  status: DeviceAuthStatus;
  userCode?: string;
  verificationUri?: string;
  expiresIn?: number;  // seconds until the device code stops being valid
  interval?: number;   // recommended polling interval, in seconds
  error?: string;
}

export interface GitHubSession {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GitHubAuthStatus {
  connected: boolean;
  session: GitHubSession | null;
  clientIdConfigured: boolean;
}
