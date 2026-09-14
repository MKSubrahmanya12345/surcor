import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

export const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
export const sent: { channel: string; payload: unknown }[] = [];
export const userDataDir = mkdtempSync(`${tmpdir()}/forge-userdata-`);

export function installElectronMock(): void {
  mock.module("electron", () => ({
    ipcMain: { handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => { handlers.set(channel, fn); } },
    app: {
      getPath: () => userDataDir,
      on: () => undefined,
      once: () => undefined,
      whenReady: () => Promise.resolve(),
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      // stands in for the OS keychain: opaque on disk, reversible here
      encryptString: (value: string) => Buffer.from(Buffer.from(value, "utf8").toString("base64"), "utf8"),
      decryptString: (buffer: Buffer) => Buffer.from(buffer.toString("utf8"), "base64").toString("utf8"),
    },
    BrowserWindow: {
      getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); } } }],
    },
  }));
}

export function invoke<T = unknown>(channel: string, payload: unknown = {}): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return Promise.resolve(handler({}, payload) as T);
}
