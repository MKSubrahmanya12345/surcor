import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IPC } from "@forge/shared";
import type { FileNode } from "@forge/shared";
import { handlers, installElectronMock, invoke } from "./harness";

installElectronMock();

const root = mkdtempSync(`${tmpdir()}/forge-prompt5-fs-`);
const workspace = path.join(root, "project");

beforeAll(async () => {
  const { registerFileSystemHandlers } = await import("../../packages/client/electron/ipc/fileSystem");
  registerFileSystemHandlers();
  mkdirSync(path.join(workspace, "src"), { recursive: true });
  writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(workspace, "readme.md"), "# hi\n");
  writeFileSync(path.join(workspace, ".DS_Store"), "noise");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("registers every file system channel", () => {
  for (const channel of [
    IPC.FS_OPEN_FOLDER, IPC.FS_READ_FILE, IPC.FS_WRITE_FILE,
    IPC.FS_LIST_DIR, IPC.FS_CREATE_FILE, IPC.FS_DELETE_FILE, IPC.FS_RENAME,
  ]) {
    expect(handlers.has(channel)).toBe(true);
  }
});

test("listDir returns folders first, then files, and stays lazy", async () => {
  const nodes = await invoke<FileNode[]>(IPC.FS_LIST_DIR, { path: workspace });
  // .DS_Store is filtered out; src sorts before readme.md
  expect(nodes.map((node) => node.name)).toEqual(["src", "readme.md"]);
  expect(nodes[0].isDirectory).toBe(true);
  expect(nodes[0].path).toBe(path.join(workspace, "src"));
  expect(nodes[0].children).toBeUndefined();
  expect(nodes[1].isDirectory).toBe(false);
});

test("creating a file also creates the folders it needs", async () => {
  const target = path.join(workspace, "src", "deep", "nested", "new.ts");
  await invoke(IPC.FS_CREATE_FILE, { path: target });
  expect(existsSync(target)).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("");
});

test("creating a file that exists says so, and leaves it alone", async () => {
  const target = path.join(workspace, "readme.md");
  await expect(invoke(IPC.FS_CREATE_FILE, { path: target })).rejects.toThrow(/already exists/);
  expect(readFileSync(target, "utf8")).toBe("# hi\n");
});

test("creating a folder is recursive, but an existing folder is an error", async () => {
  const target = path.join(workspace, "docs", "guides");
  await invoke(IPC.FS_CREATE_FILE, { path: target, isDirectory: true });
  expect(existsSync(target)).toBe(true);
  await expect(invoke(IPC.FS_CREATE_FILE, { path: target, isDirectory: true })).rejects.toThrow(/already exists/);
});

test("deleting removes a whole folder", async () => {
  const target = path.join(workspace, "docs");
  writeFileSync(path.join(target, "guides", "a.md"), "x");
  await invoke(IPC.FS_DELETE_FILE, { path: target });
  expect(existsSync(target)).toBe(false);
});

test("deleting something that is already gone reports it in plain words", async () => {
  const target = path.join(workspace, "nope.ts");
  await expect(invoke(IPC.FS_DELETE_FILE, { path: target })).rejects.toThrow(/does not exist/);
});

test("renaming moves the entry, and a missing source is reported", async () => {
  const from = path.join(workspace, "src", "a.ts");
  const to = path.join(workspace, "src", "b.ts");
  await invoke(IPC.FS_RENAME, { oldPath: from, newPath: to });
  expect(readFileSync(to, "utf8")).toBe("export const a = 1;\n");
  expect(existsSync(from)).toBe(false);
  await expect(invoke(IPC.FS_RENAME, { oldPath: from, newPath: to })).rejects.toThrow(/does not exist/);
});

test("reading and writing report readable errors", async () => {
  await expect(invoke(IPC.FS_READ_FILE, { path: path.join(workspace, "ghost.ts") })).rejects.toThrow(/does not exist/);
  const target = path.join(workspace, "written.txt");
  await invoke(IPC.FS_WRITE_FILE, { path: target, content: "hello" });
  expect(await invoke<string>(IPC.FS_READ_FILE, { path: target })).toBe("hello");
});

test("payloads are validated before anything touches the disk", async () => {
  await expect(invoke(IPC.FS_CREATE_FILE, { path: "" })).rejects.toThrow();
  await expect(invoke(IPC.FS_LIST_DIR, { directory: workspace })).rejects.toThrow();
  await expect(invoke(IPC.FS_RENAME, { oldPath: workspace })).rejects.toThrow();
});
