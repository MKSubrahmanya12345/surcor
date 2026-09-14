import { BrowserWindow, app, ipcMain } from "electron";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { IPC } from "@forge/shared";
import type * as NodePty from "node-pty";

// node-pty is a native addon: it must never be bundled into the Electron main
// bundle, so it is resolved at runtime through createRequire instead of a
// static import. It also has to be compiled against Electron's ABI, which is
// what `bun run rebuild` does.
type PtyModule = typeof NodePty;

const nodeRequire = createRequire(import.meta.url);

const PTY_HELP =
  "node-pty is not available for this build. Run `bun run rebuild` (needs a C/C++ toolchain and network access) and restart Forge.";

const createPayload = z
  .object({
    cwd: z.string().min(1).optional(),
    shell: z.string().min(1).optional(),
    cols: z.number().int().min(2).max(1000).optional(),
    rows: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

const idPayload = z.object({ id: z.string().min(1) }).strict();

const writePayload = z
  .object({ id: z.string().min(1), data: z.string() })
  .strict();

const resizePayload = z
  .object({
    id: z.string().min(1),
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(1).max(1000),
  })
  .strict();

interface TerminalSession {
  id: string;
  pty: NodePty.IPty;
  shell: string;
  cwd: string;
}

const sessions = new Map<string, TerminalSession>();
let ptyModule: PtyModule | null = null;
let ptyLoadError: string | null = null;
let quitHookRegistered = false;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function loadPty(): PtyModule {
  if (ptyModule) return ptyModule;
  if (ptyLoadError) throw new Error(ptyLoadError);
  try {
    ptyModule = nodeRequire("node-pty") as PtyModule;
    return ptyModule;
  } catch (error) {
    ptyLoadError = `${PTY_HELP} (${errorMessage(error)})`;
    throw new Error(ptyLoadError);
  }
}

/** Shells that understand `-l` (login shell), so the user's PATH is loaded. */
const LOGIN_SHELLS = new Set(["bash", "zsh", "sh", "fish", "ksh", "dash", "ash"]);

function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC ?? "powershell.exe";
  }
  return process.env.SHELL ?? "/bin/bash";
}

function shellArgs(shell: string): string[] {
  const base = path.basename(shell).replace(/\.exe$/i, "");
  return LOGIN_SHELLS.has(base) ? ["-l"] : [];
}

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = { TERM: "xterm-256color", COLORTERM: "truecolor" };
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

/** Spawns a pty, turning any native-module failure into actionable guidance. */
function spawnPty(
  shell: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
): NodePty.IPty {
  const pty = loadPty();
  try {
    return pty.spawn(shell, args, options);
  } catch (error) {
    // e.g. NODE_MODULE_VERSION mismatch or a missing prebuild
    throw new Error(`${PTY_HELP} (${errorMessage(error)})`);
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

export function killAllTerminals(): void {
  for (const session of sessions.values()) {
    try {
      session.pty.kill();
    } catch {
      // the process is already gone
    }
  }
  sessions.clear();
}

export function registerTerminalHandlers(): void {
  if (!quitHookRegistered) {
    quitHookRegistered = true;
    app.on("before-quit", killAllTerminals);
  }

  ipcMain.handle(IPC.TERMINAL_CREATE, async (_event, payload: unknown) => {
    const input = createPayload.parse(payload);
    const shell = input.shell ?? defaultShell();
    const cwd = input.cwd ?? os.homedir();

    const sessionId = crypto.randomUUID();
    const instance = spawnPty(shell, shellArgs(shell), {
      name: "xterm-256color",
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
      cwd,
      env: shellEnv(),
    });

    const session: TerminalSession = { id: sessionId, pty: instance, shell, cwd };
    sessions.set(sessionId, session);

    instance.onData((data: string) => {
      if (!sessions.has(sessionId)) return;
      broadcast(IPC.TERMINAL_DATA, { id: sessionId, data });
    });

    instance.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      if (!sessions.has(sessionId)) return;
      sessions.delete(sessionId);
      broadcast(IPC.TERMINAL_EXIT, { id: sessionId, exitCode, signal });
    });

    return { id: sessionId, shell, cwd };
  });

  ipcMain.handle(IPC.TERMINAL_WRITE, (_event, payload: unknown) => {
    const { id, data } = writePayload.parse(payload);
    const session = sessions.get(id);
    if (!session) return;
    session.pty.write(data);
  });

  ipcMain.handle(IPC.TERMINAL_RESIZE, (_event, payload: unknown) => {
    const { id, cols, rows } = resizePayload.parse(payload);
    const session = sessions.get(id);
    if (!session) return;
    session.pty.resize(cols, rows);
  });

  ipcMain.handle(IPC.TERMINAL_KILL, (_event, payload: unknown) => {
    const { id } = idPayload.parse(payload);
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    try {
      session.pty.kill();
    } catch {
      // already exited
    }
  });
}
