import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Minimal Electron stand-in for the Prompt 5 file-system tests.
 *
 * Same shape as `tests/prompt2/harness.ts`, plus `dialog`, because
 * `electron/ipc/fileSystem.ts` imports it. The module under test is imported
 * dynamically in `beforeAll`, i.e. after `installElectronMock()` has run, so
 * `ipcMain.handle` lands in the map below.
 */
export const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
export const sent: { channel: string; payload: unknown }[] = [];
export const userDataDir = mkdtempSync(`${tmpdir()}/forge-userdata-`);

export function installElectronMock(): void {
  mock.module("electron", () => ({
    ipcMain: {
      handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
        handlers.set(channel, fn);
      },
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }) },
    app: {
      getPath: () => userDataDir,
      on: () => undefined,
      once: () => undefined,
      whenReady: () => Promise.resolve(),
    },
    BrowserWindow: {
      getAllWindows: () => [{
        isDestroyed: () => false,
        webContents: { send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); } },
      }],
    },
  }));
}

export function invoke<T = unknown>(channel: string, payload: unknown = {}): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return Promise.resolve(handler({}, payload) as T);
}
