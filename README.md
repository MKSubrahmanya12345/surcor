# Forge

A from-scratch, Cursor-style desktop code editor built with Electron, React, TypeScript, and Monaco Editor.

## Development

```bash
bun install
bun run rebuild   # compiles node-pty against Electron's ABI (first run only)
bun run dev
```

> After pulling or merging, run `bun install` again — new dependencies are not installed
> automatically, and a stale `node_modules` shows up as `Failed to resolve import
> "@xterm/xterm/css/xterm.css"`, `Rolldown failed to resolve import "simple-git"`, and
> `Cannot find package 'simple-git'` at startup.

## Build

```bash
bun run build
```

This bundles the agent server to a single file (`packages/server/dist/server.js`
via `bun build --target bun`), builds the Electron client with Vite, and then
packages installers with electron-builder (`.dmg` on macOS, NSIS `.exe` on
Windows, AppImage on Linux — `packages/client/electron-builder.yml`, output in
`packages/client/release/`). The packaged app auto-starts the agent server; no
manual `bun run` of the backend is required (Bun must be on PATH).

## Tests

```bash
bun test          # main-process IPC handlers, run against a real git repo
```

## Prompt 1 — editor shell

Monaco editor, file tree, tabs with dirty state, resizable panes, status bar, native folder picker.

## Prompt 2 — terminal, git, GitHub

### Embedded terminal

- Real shells through **node-pty** in the Electron main process, rendered with **xterm.js**.
- Multiple terminal tabs; each tab owns its own pty session.
- Shells start as login shells in the open folder, so `bun`, `node`, `nvm` etc. are on `PATH`.
- Resizable panel, <kbd>Ctrl</kbd>+<kbd>`</kbd> to toggle.

> `node-pty` is a native module and must be compiled for Electron, not for your system Node.
> `bun install` builds it for Node; **`bun run rebuild`** (electron-rebuild) rebuilds it for Electron.
> If it is missing, the terminal panel shows that exact command instead of failing silently.

### Source control

- `git status`, staged/unstaged lists, per-file stage/unstage/discard, stage-all.
- Monaco `DiffEditor` preview (worktree ↔ index ↔ HEAD), binary-aware, 2 MB truncation guard.
- Commit, Commit &amp; Push, Pull, and ahead/behind indicators.
- Branch + changed-file count in Prompt 1's `#status-git-slot` (filled by a portal, `StatusBar.tsx` untouched).
- <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> opens the panel, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> goes back to the explorer.

### GitHub

- OAuth **device flow** (`@octokit/auth-oauth-device`) — required because a desktop app has no
  redirect URL to receive a web callback.
- Tokens are encrypted with Electron's **safeStorage** (OS keychain) before being written to disk,
  never stored in plaintext.
- Repository list with a **Clone** button that clones into a folder you pick and then opens it with
  the *existing* `useWorkspaceStore.openFolder` action — there is only one folder-opening path.

#### Configuring a GitHub OAuth app

Device flow needs a GitHub OAuth App **Client ID** (no client secret). Create one at
<https://github.com/settings/developers> — the callback URL is unused but GitHub requires one, so use
`http://localhost`.

Then either:

```bash
export FORGE_GITHUB_CLIENT_ID=Iv1.yourclientid
bun run dev
```

…or paste the Client ID into the GitHub panel — the app asks for one when none is configured.

### Shared contract

`packages/shared` is the single source of truth. Prompt 2 only **appended** to it:

- `ipc-channels.ts`: `TERMINAL_*`, `GIT_*`, `GITHUB_*` keys added inside the existing `IPC` object.
- `types.ts`: `TerminalSessionInfo`, `TerminalTab`, `GitFileStatus`, `GitStatusSummary`, `GitDiff`,
  `GitBranchInfo`, `GitOperationResult`, `GitCloneResult`, `GitHubRepo`, `DeviceAuthState`,
  `GitHubSession`, `GitHubAuthStatus`. No existing export was changed or removed.

## Prompt 3 — agent server

Standalone Bun process (`packages/server`) reachable at `ws://localhost:4500`:

- Provider router with fallback: Anthropic → OpenAI → Gemini → Ollama (order via `PROVIDER_ORDER`
  in `packages/server/.env`), streaming, per-provider timeout.
- Agentic loop with tool use: `read_file`, `write_file`, `list_dir`, `run_terminal_command`,
  `apply_diff` (proposal-only; never writes to disk itself).
- Modes: **Ask** (no tools), **Agent** (full tool loop), **Plan** (numbered plan first, execution
  only after an explicit `approve_plan` message).
- `bun:sqlite` persistence for sessions, messages, checkpoints metadata, and pending diffs.
- Start it with `bun run packages/server/src/server.ts`.

## Prompt 4 — chat panel, modes, diff review, checkpoints

The Cursor-style chat experience, mounted in Prompt 1's `#panel-right-slot`:

- `services/agentSocket.ts` — the **only** renderer file that opens a WebSocket to the agent
  server. Connects on launch, sends `init` with the open workspace root, reconnects with backoff,
  and remembers the server session id per workspace (localStorage) so history survives restarts.
  Override the endpoint with `VITE_FORGE_AGENT_URL` / `VITE_FORGE_AGENT_TOKEN` if needed.
- `ChatPanel` — streaming messages (token-by-token `chat_chunk` deltas), markdown rendering,
  collapsed `used tool: name(args)` lines with expandable output, an Ask | Agent | Plan mode
  switcher, Enter-to-send composer, and a Cancel button while a turn runs.
- `DiffReview` — side-by-side Monaco `DiffEditor` for every pending `diff_proposed`. Accept writes
  through Prompt 1's `fs:writeFile` IPC handler (the single file-write path) and refreshes the open
  tab's content and dirty state; Reject only sends the `diff_decision`.
- `PlanApproval` — Approve / Edit plan buttons under a pending plan. Approve sends `approve_plan`;
  nothing executes before that.
- `CheckpointBar` — before the first write-type tool call of a turn, the client snapshots every
  file open in a tab into a Checkpoint (persisted in localStorage; checkpoints are a client-side
  undo concept). "Restore to before last change" writes the snapshot back to disk via
  `fs:writeFile` and refreshes the open tabs.
- `packages/shared` was **not** modified — Prompt 3's protocol already covered every message shape.

## Prompt 5 — codebase indexing, web search, Bedrock, explorer file ops

### Semantic codebase search (`search_codebase`)

- `packages/server/src/index/` — chunker, gitignore-style matcher, embedder, SQLite store, indexer,
  cosine-similarity search, and a module-level index service the tools reach through.
- Files are split on blank-line blocks up to a token budget (no tree-sitter, no new dependency),
  embedded with **Ollama `nomic-embed-text`** by default — `EMBEDDING_PROVIDER=openai` switches to
  `text-embedding-3-small` — and stored in the **same SQLite database** as Prompt 3 (`embeddings`
  and `indexed_files` tables added by a migration; there is still exactly one DB file).
- Vectors are cached in memory as `Float32Array` and scored with a linear dot-product scan: a few
  thousand chunks answer in single-digit milliseconds with no native vector index.
- The index is built when a workspace is opened and kept current: every `write_file` tool call
  re-indexes that one file, and `ensureFresh()` stat-walks the tree so edits made in the editor —
  which never pass through the server — are picked up before a search runs.
- Respects `.gitignore`, `.forgeignore`, nested ignore files, binary extensions, lock files, and
  minified bundles. `path_prefix` narrows a search to a subtree.

### Web search (`web_search`)

- **Tavily** first (`TAVILY_API_KEY`), falling back to **Brave Search** (`BRAVE_SEARCH_API_KEY`).
  With neither key configured the tool says so instead of failing silently.
- Results are normalised to `{ title, url, snippet, score? }` and trimmed to a character budget so
  one search cannot blow up the context window.
- The chat panel's collapsed tool line shows the query for `web_search` / `search_codebase`.

### Amazon Bedrock provider

- `providers/bedrock.ts`, with `providers/aws/{sigv4,credentials,eventStream}.ts` underneath it —
  the **Converse API** (`ConverseStream`), registered as a fifth provider choice next to
  anthropic/openai/gemini/ollama (`PROVIDER_ORDER=anthropic,bedrock,…`).
- Decodes AWS's `application/vnd.amazon.eventstream` binary framing (it is *not* SSE) into the same
  stream-event shape the router already consumes; tool use, system prompts and stop reasons map
  onto the shared provider interface.
- Auth: SigV4 with `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (+ optional session token), or a
  bearer token via `AWS_BEARER_TOKEN_BEDROCK`, or the ambient credential chain.

### Configuration

`packages/server/.env.example` and `packages/client/.env.example` document every variable — server
port/token, each provider, Bedrock's three auth options, agent limits, indexing, web search, client
endpoints, and the GitHub device flow. Copy to `.env` and fill in what you need.

### Explorer file operations

The main process has had `fs:createFile`, `fs:rename` and `fs:deleteFile` since Prompt 1 — the tree
simply had no UI for them. Now it does:

- Toolbar on the EXPLORER header: **New File**, **New Folder**, **Refresh**, **Collapse Folders**.
  They act on the selected folder (or the workspace root when nothing is selected).
- Right-click context menu on files, folders and empty space: New File/Folder, Expand/Collapse,
  Rename, Delete, Copy Path, Copy Relative Path.
- Inline name input, VS Code-style — renaming a file pre-selects the name without its extension,
  <kbd>Enter</kbd> commits, <kbd>Esc</kbd> cancels. Nested names (`src/components/New.tsx`) create
  the missing folders on the way down.
- Selection plus <kbd>F2</kbd> (rename) and <kbd>Del</kbd> (delete, with a confirmation) on the
  focused tree.
- Open tabs follow the file system: a renamed or moved file keeps its tab, deleting a folder closes
  every tab inside it, and a refresh re-reads the visible tree without collapsing it.
- `fs:createFile` now creates missing parents, refuses to overwrite an existing file (`wx`), and
  every handler reports readable messages (`"x.ts" already exists.`) instead of raw errno codes.
- All tree logic lives in `components/FileTree/treeOps.ts`: pure, Windows-aware path helpers with
  no React and no store in them, so they are unit-testable and the component stays about rendering.

### Tests

`tests/prompt5/` — tree ops, the workspace store's create/rename/delete bookkeeping against an
in-memory file system, the chunker, the ignore matcher, the search maths, and the file-system IPC
handlers against a real temporary directory. Run everything with `bun test`.
## Prompt 6 — MCP client, command palette & keybindings, project rules, packaging

### MCP servers (external tools)

Drop entries into `~/.forge/mcp.json` (same shape as Claude Desktop / Cursor) or
use the Settings panel (gear icon in the activity bar) to add/remove them
without hand-editing JSON. The agent server spawns each configured stdio MCP
server, calls `tools/list`, and registers every tool into the same registry as
the built-ins, namespaced `mcp__<server>__<tool>` — the chat UI renders them
exactly like built-in tool calls. Config edits are picked up automatically
(file watcher + `mcp_reload`), and the Settings panel shows live connection
state and the registered tool names per server. The stdio transport
(JSON-RPC 2.0 with `Content-Length` framing: `initialize`, `notifications/initialized`,
`tools/list`, `tools/call`) is implemented dependency-free in
`packages/server/src/mcp/clientManager.ts`; the wire format is identical to the
official SDK's StdioClientTransport, so existing configs work unchanged.

### Command palette & keybindings

- `Cmd/Ctrl+Shift+P` — command palette (Open Folder, Toggle Terminal, Toggle
  Chat Panel, Switch Agent Mode, New Terminal, Clone Repository, …), fuzzy search.
- `Cmd/Ctrl+P` — quick file open (type `>` to switch into command mode).
- `Cmd/Ctrl+`` ` — toggle terminal · `Cmd/Ctrl+B` — toggle file tree ·
  `Cmd/Ctrl+L` — focus chat (Cursor's default).

### Project rules (`.forge/rules.md`)

If `<workspace>/.forge/rules.md` exists, its contents are read once at
connection time and prepended to the system message of every conversation
(Cursor's `.cursor/rules` equivalent). Test: write "Always respond in French"
and the agent does.

### Packaging & auto-start

See **Build** above. On launch the Electron main process health-checks
`ws://localhost:4500`; only when nothing answers does it spawn
`bun run packages/server/src/server.ts` (dev) or the bundled
`forge-server/server.js` resource (packaged). It never kills a server it did
not spawn, and `FORGE_SERVER_EXTERNAL=1` disables auto-start entirely.
