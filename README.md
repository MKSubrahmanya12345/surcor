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
