import { afterEach, beforeAll, expect, mock, test } from "bun:test";
import { IPC } from "@forge/shared";
import { handlers, installElectronMock, sent, invoke } from "./harness";

installElectronMock();

class FakePty {
  writes: string[] = [];
  resizes: { cols: number; rows: number }[] = [];
  killed = false;
  dataListeners: ((data: string) => void)[] = [];
  exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];

  constructor(public shell: string, public args: string[], public options: Record<string, unknown>) {}

  onData(listener: (data: string) => void) { this.dataListeners.push(listener); }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) { this.exitListeners.push(listener); }
  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.resizes.push({ cols, rows }); }
  kill() { this.killed = true; }
  emit(data: string) { for (const listener of this.dataListeners) listener(data); }
  exit(code: number) { for (const listener of this.exitListeners) listener({ exitCode: code, signal: 0 }); }
}

const spawned: FakePty[] = [];
let ptyLoadsWithError: string | null = null;

mock.module("node-pty", () => {
  if (ptyLoadsWithError) throw new Error(ptyLoadsWithError);
  return {
    spawn: (shell: string, args: string[], options: Record<string, unknown>) => {
      const instance = new FakePty(shell, args, options);
      spawned.push(instance);
      return instance;
    },
  };
});

let registerTerminalHandlers: () => void;
let killAllTerminals: () => void;

beforeAll(async () => {
  const module = await import("../../packages/client/electron/ipc/terminal");
  registerTerminalHandlers = module.registerTerminalHandlers;
  killAllTerminals = module.killAllTerminals;
  registerTerminalHandlers();
});

afterEach(() => {
  sent.length = 0;
});

test("registers the invoke channels; data/exit stay as push channels", () => {
  for (const channel of [IPC.TERMINAL_CREATE, IPC.TERMINAL_WRITE, IPC.TERMINAL_RESIZE, IPC.TERMINAL_KILL]) {
    expect(handlers.has(channel)).toBe(true);
  }
  expect(handlers.has(IPC.TERMINAL_DATA)).toBe(false);
  expect(handlers.has(IPC.TERMINAL_EXIT)).toBe(false);
});

test("terminal:create spawns a pty in the requested folder and returns a session id", async () => {
  const created = await invoke<{ id: string; shell: string; cwd: string }>(IPC.TERMINAL_CREATE, { cwd: "/tmp/workspace", cols: 100, rows: 30 });
  expect(created.id).toBeString();
  expect(created.cwd).toBe("/tmp/workspace");
  expect(spawned.at(-1)!.shell).toBe(created.shell);
  expect(spawned.at(-1)!.options).toMatchObject({ cols: 100, rows: 30, cwd: "/tmp/workspace" });
  expect(spawned.at(-1)!.options.env).toMatchObject({ TERM: "xterm-256color" });
});

test("spawned shells get a login flag so the user's PATH is loaded", () => {
  const instance = spawned.at(-1)!;
  const base = instance.shell.split("/").pop();
  expect(instance.args).toEqual(["bash", "zsh", "sh", "fish", "ksh", "dash", "ash"].includes(base!) ? ["-l"] : []);
});

test("terminal:write forwards keystrokes to the right pty", async () => {
  const a = await invoke<{ id: string }>(IPC.TERMINAL_CREATE, { cwd: "/tmp" });
  const b = await invoke<{ id: string }>(IPC.TERMINAL_CREATE, { cwd: "/tmp" });
  await invoke(IPC.TERMINAL_WRITE, { id: a.id, data: "ls -la\r" });
  await invoke(IPC.TERMINAL_WRITE, { id: b.id, data: "pwd\r" });

  const ptyA = spawned.find((pty) => pty.options.cwd === "/tmp" && pty.writes.includes("ls -la\r"))!;
  expect(ptyA.writes).toEqual(["ls -la\r"]);
  expect(spawned.some((pty) => pty.writes.includes("pwd\r"))).toBe(true);
});

test("pty output is broadcast to the renderer as terminal:data", async () => {
  const session = await invoke<{ id: string }>(IPC.TERMINAL_CREATE, { cwd: "/tmp" });
  const pty = spawned.at(-1)!;
  pty.emit("hello from the shell\r\n");
  expect(sent.at(-1)).toEqual({ channel: IPC.TERMINAL_DATA, payload: { id: session.id, data: "hello from the shell\r\n" } });
});

test("terminal:resize resizes the pty", async () => {
  const session = await invoke<{ id: string }>(IPC.TERMINAL_CREATE, { cwd: "/tmp" });
  const pty = spawned.at(-1)!;
  await invoke(IPC.TERMINAL_RESIZE, { id: session.id, cols: 120, rows: 40 });
  expect(pty.resizes.at(-1)).toEqual({ cols: 120, rows: 40 });
});

test("terminal:exit is broadcast and the session is dropped", async () => {
  const session = await invoke<{ id: string }>(IPC.TERMINAL_CREATE, { cwd: "/tmp" });
  const pty = spawned.at(-1)!;
  pty.exit(0);
  expect(sent.at(-1)).toEqual({ channel: IPC.TERMINAL_EXIT, payload: { id: session.id, exitCode: 0, signal: 0 } });

  // writing to a dead session is a no-op instead of a crash
  await invoke(IPC.TERMINAL_WRITE, { id: session.id, data: "still typing\r" });
  expect(pty.writes).toEqual([]);
});

test("terminal:kill kills the pty", async () => {
  const session = await invoke<{ id: string }>(IPC.TERMINAL_CREATE, { cwd: "/tmp" });
  const pty = spawned.at(-1)!;
  await invoke(IPC.TERMINAL_KILL, { id: session.id });
  expect(pty.killed).toBe(true);
});

test("killAllTerminals tears every session down", async () => {
  await invoke(IPC.TERMINAL_CREATE, { cwd: "/tmp" });
  await invoke(IPC.TERMINAL_CREATE, { cwd: "/tmp" });
  const before = spawned.filter((pty) => !pty.killed).length;
  killAllTerminals();
  const after = spawned.filter((pty) => !pty.killed).length;
  expect(after).toBeLessThan(before);
});
