import { expect, mock, test } from "bun:test";
import { IPC } from "@forge/shared";
import { handlers, installElectronMock, invoke } from "./harness";

installElectronMock();
// a broken native build blows up the moment the addon is touched
mock.module("node-pty", () => ({
  spawn: () => {
    throw new Error("Cannot find module './build/Release/pty.node'");
  },
}));

test("a terminal session surfaces an actionable error when node-pty is not built", async () => {
  const { registerTerminalHandlers } = await import("../../packages/client/electron/ipc/terminal");
  registerTerminalHandlers();
  expect(handlers.has(IPC.TERMINAL_CREATE)).toBe(true);

  const error = await invoke(IPC.TERMINAL_CREATE, { cwd: "/tmp" }).catch((thrown: Error) => thrown);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("bun run rebuild");
  expect((error as Error).message).toContain("pty.node");
});
