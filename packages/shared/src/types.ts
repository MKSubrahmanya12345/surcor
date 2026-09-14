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
  | { type: "error"; message: string }
  | { type: "session_ready"; sessionId: string; workspaceRoot: string; history: ChatMessage[]; pendingPlanId?: string; pendingDiffs: DiffProposal[] }
  | { type: "plan_ready"; messageId: string }
  // A failed streaming provider is replaced, not concatenated with its fallback.
  | { type: "chat_reset"; messageId: string }
  // Chunks are incremental; the existing tool_result is the final, complete result.
  | { type: "tool_result_chunk"; result: ToolResult; stream: TerminalOutputStream }
  // Prompt 6: MCP server connection states, broadcast on change and on request.
  | { type: "mcp_status"; servers: McpServerStatus[] };

export type ClientMessage =
  | { type: "user_message"; content: string; mode: AgentMode }
  | { type: "diff_decision"; diffId: string; decision: "accept" | "reject" }
  | { type: "cancel" }
  | { type: "init"; workspaceRoot: string; sessionId?: string }
  | { type: "approve_plan" }
  // Prompt 6: ask for the current MCP server states / re-read ~/.forge/mcp.json.
  | { type: "mcp_status_request" }
  | { type: "mcp_reload" };

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

// ---------------------------------------------------------------------------
// Agent server (Prompt 3). Canonical contracts, including provider/tool APIs.
// ---------------------------------------------------------------------------

// "bedrock" is an APPENDED union member (Amazon Bedrock Converse API). Every
// previously valid ProviderName value remains valid and unchanged.
export type ProviderName = "anthropic" | "openai" | "gemini" | "ollama" | "bedrock";
export type TerminalOutputStream = "stdout" | "stderr";

export interface ProviderToolCall extends ToolCall {
  // Gemini thinking models require this opaque signature on subsequent turns.
  providerMetadata?: { geminiThoughtSignature?: string };
}

export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ProviderToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderRequest {
  messages: ProviderMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  maxTokens?: number;
}

export interface ProviderResponse {
  content: string;
  toolCalls: ProviderToolCall[];
}

export type ProviderStreamEvent =
  | { type: "text"; delta: string }
  | { type: "reset" }
  | { type: "complete"; response: ProviderResponse };

export interface ProviderAdapter {
  name: ProviderName | "router";
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  streamComplete(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}

export interface ProviderConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface ProviderToolCallAccumulator {
  id: string;
  name: string;
  argumentsJson: string;
  initialArgs?: Record<string, unknown>;
}

export interface AgentServerConfig {
  hostname: string;
  port: number;
  databasePath: string;
  token?: string;
  allowedOrigins: string[];
  providerOrder: ProviderName[];
  providers: Record<ProviderName, ProviderConfig>;
  providerTimeoutMs: number;
  maxTurns: number;
  maxToolCallsPerTurn: number;
  maxTokens: number;
  commandTimeoutMs: number;
  maxFileBytes: number;
  maxOutputBytes: number;
  // Appended with Prompt 5: Amazon Bedrock (Converse), codebase indexing, web search.
  bedrock: BedrockConfig;
  index: IndexConfig;
  webSearch: WebSearchConfig;
}

export interface AgentSession {
  id: string;
  workspaceRoot: string;
  pendingPlanId: string | null;
}

export interface StoredChatMessage {
  id: string;
  role: ChatMessage["role"];
  content: string;
  mode: AgentMode;
  createdAt: number;
  toolCallsJson: string | null;
}

export interface StoredDiffProposal extends DiffProposal {
  sessionId: string;
}

export interface StoredSetting {
  value: string;
}

export interface AgentDatabase {
  openSession(workspaceRoot: string, sessionId?: string): AgentSession;
  listMessages(sessionId: string, limit?: number): ChatMessage[];
  getMessage(sessionId: string, messageId: string): ChatMessage | undefined;
  appendMessage(sessionId: string, message: ChatMessage): void;
  setPendingPlan(sessionId: string, messageId: string | null): void;
  saveDiff(sessionId: string, diff: DiffProposal): void;
  listPendingDiffs(sessionId: string): DiffProposal[];
  decideDiff(sessionId: string, diffId: string, decision: "accept" | "reject"): DiffProposal;
  getSetting<T>(key: string): T | undefined;
  setSetting(key: string, value: unknown): void;
  close(): void;
}

export interface AgentToolContext {
  workspaceRoot: string;
  sessionId: string;
  database: AgentDatabase;
  signal: AbortSignal;
  emit: (message: ServerMessage) => void;
  commandTimeoutMs: number;
  maxFileBytes: number;
  maxOutputBytes: number;
}

export type ToolHandler = (
  call: ToolCall,
  context: AgentToolContext,
) => Promise<ToolResult>;

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export interface ReadFileArgs {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface WriteFileArgs {
  path: string;
  content: string;
}

export interface ListDirArgs {
  path?: string;
}

export interface RunTerminalCommandArgs {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ApplyDiffArgs {
  path: string;
  proposedContent: string;
  originalContent?: string;
}

export interface AgentModePolicy {
  toolsAllowed: boolean;
  requiresPlan: boolean;
  instruction: string;
}

export interface AgentTurnContext extends AgentToolContext {
  provider: ProviderAdapter;
  mode: AgentMode;
  planApproved: boolean;
  maxTurns: number;
  maxToolCallsPerTurn: number;
  maxTokens: number;
}

export interface AgentSocketState {
  session: AgentSession | null;
  initializing: boolean;
  closed: boolean;
  activeTurn: AbortController | null;
  activeTask: Promise<void> | null;
  queue: Promise<void>;
  queuedMessages: number;
}

// ---------------------------------------------------------------------------
// Amazon Bedrock (added with Prompt 5). ProviderName is widened by APPENDING a
// member — no existing member was renamed or removed, so every existing
// `ProviderName` value stays valid.
// ---------------------------------------------------------------------------

export interface BedrockCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Epoch ms after which these credentials must be resolved again. */
  expiresAt?: number;
}

export interface BedrockConfig {
  region: string;
  model: string;               // inference profile id, model id, or profile ARN
  baseUrl: string;             // https://bedrock-runtime.{region}.amazonaws.com
  streaming: boolean;          // false => non-streaming POST /model/{id}/converse
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** AWS_BEARER_TOKEN_BEDROCK: skips SigV4 entirely when present. */
  bearerToken?: string;
  /** Shared-credentials profile used when no static keys are configured. */
  profile?: string;
}

// ---------------------------------------------------------------------------
// Codebase indexing + semantic search (Prompt 5)
// ---------------------------------------------------------------------------

export interface CodeChunk {
  id: string;                  // stable: `${workspaceId}:${relativePath}:${startLine}`
  relativePath: string;        // workspace-relative, "/" separated
  absolutePath: string;
  startLine: number;           // 1-based, inclusive
  endLine: number;             // 1-based, inclusive
  language: string;            // monaco language id
  content: string;
  tokenEstimate: number;
}

export interface SearchResult {
  score: number;               // cosine similarity, -1..1 (0..1 in practice)
  relativePath: string;
  absolutePath: string;
  startLine: number;
  endLine: number;
  language: string;
  snippet: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  publishedDate?: string;
}

export interface WebSearchResponse {
  provider: "tavily" | "brave";
  query: string;
  answer?: string;             // Tavily's synthesized answer, when requested
  results: WebSearchResult[];
}

export interface SearchCodebaseArgs {
  query: string;
  topK?: number;
  pathPrefix?: string;         // restrict matches to this workspace-relative subtree
}

export interface WebSearchArgs {
  query: string;
  maxResults?: number;
}

export type IndexStatus = "idle" | "indexing" | "ready" | "error";

export interface IndexStats {
  workspaceRoot: string;
  status: IndexStatus;
  files: number;
  chunks: number;
  skipped: number;             // ignored / binary / oversize files
  model: string | null;        // embedding model the stored vectors came from
  dimensions: number | null;
  provider: string | null;     // "ollama" | "openai"
  lastBuildAt: number | null;
  lastError: string | null;
}

export type EmbeddingKind = "document" | "query";

export interface EmbeddingRequest {
  texts: string[];
  kind: EmbeddingKind;
  signal?: AbortSignal;
}

export interface EmbeddingProvider {
  name: "ollama" | "openai";
  model: string;
  embed(request: EmbeddingRequest): Promise<number[][]>;
}

export interface IndexConfig {
  enabled: boolean;
  maxFiles: number;
  maxFileBytes: number;
  maxChunkTokens: number;
  maxDepth: number;
  batchSize: number;
  embeddingOrder: ("ollama" | "openai")[];
  ollama: { baseUrl: string; model: string };
  openai: { baseUrl: string; model: string; apiKey?: string };
  requestTimeoutMs: number;
}

export interface WebSearchConfig {
  tavilyApiKey?: string;
  tavilyBaseUrl: string;
  braveApiKey?: string;
  braveBaseUrl: string;
  requestTimeoutMs: number;
  defaultMaxResults: number;
}

export interface StoredIndexWorkspace {
  id: string;
  workspaceRoot: string;
  model: string | null;
  dimensions: number | null;
  status: IndexStatus;
  files: number;
  chunks: number;
  lastBuildAt: number | null;
  lastError: string | null;
}

export interface StoredIndexFile {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
  chunks: number;
  indexedAt: number;
}

export interface StoredEmbedding {
  id: string;
  relativePath: string;
  absolutePath: string;
  startLine: number;
  endLine: number;
  language: string;
  content: string;
  vectorJson: string;
  model: string;
  dimensions: number;
  indexedAt: number;
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) client (Prompt 6): external stdio tool servers
// ---------------------------------------------------------------------------

/** One entry in ~/.forge/mcp.json (same shape as Claude Desktop / Cursor). */
export interface McpServerConfig {
  name: string;                // unique key, becomes the tool namespace
  command: string;             // executable spawned by the agent server
  args: string[];
  env?: Record<string, string>;
}

export type McpServerState = "starting" | "connected" | "error" | "stopped";

/** Live connection state of one configured MCP server, reported by the agent server. */
export interface McpServerStatus {
  name: string;
  state: McpServerState;
  toolCount: number;           // tools registered as mcp__<name>__<tool>
  toolNames: string[];
  error?: string;
}
