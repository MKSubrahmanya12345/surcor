import { beforeAll, expect, test } from "bun:test";
import type { FileNode } from "@forge/shared";
import { findNode } from "../../packages/client/src/components/FileTree/treeOps";

/**
 * The explorer's create/rename/delete actions against an in-memory file system.
 *
 * The point of these tests is the tree bookkeeping around the IPC call: which
 * directories get re-listed, what happens to expansion state, and how open tabs
 * follow a moved or deleted file.
 */

const ROOT = "/workspace";
const dirs = new Set<string>([ROOT]);
const files = new Map<string, string>();

const nameOf = (target: string): string => target.split("/").pop() ?? target;
const parentOf = (target: string): string => target.slice(0, target.lastIndexOf("/")) || "/";

const ensureParents = (target: string): void => {
  let cursor = parentOf(target);
  while (cursor && !dirs.has(cursor)) {
    dirs.add(cursor);
    if (cursor === ROOT || !cursor.includes("/")) break;
    cursor = parentOf(cursor);
  }
};

const listDir = async (directoryPath: string): Promise<FileNode[]> => {
  if (!dirs.has(directoryPath)) throw new Error(`"${directoryPath}" does not exist.`);
  const prefix = `${directoryPath}/`;
  const entries = new Map<string, boolean>();
  for (const dir of dirs) {
    if (!dir.startsWith(prefix)) continue;
    const head = dir.slice(prefix.length).split("/")[0];
    if (head) entries.set(head, true);
  }
  for (const filePath of files.keys()) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    if (!rest.includes("/")) entries.set(rest, false);
  }
  return [...entries.entries()]
    .sort((a, b) => (a[1] !== b[1] ? (a[1] ? -1 : 1) : a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: "base" })))
    .map(([name, isDirectory]) => ({ path: `${prefix}${name}`, name, isDirectory }));
};

const createFile = async (target: string, isDirectory?: boolean): Promise<void> => {
  if (isDirectory) {
    if (dirs.has(target)) throw new Error(`"${nameOf(target)}" already exists.`);
    ensureParents(target);
    dirs.add(target);
    return;
  }
  if (files.has(target) || dirs.has(target)) throw new Error(`"${nameOf(target)}" already exists.`);
  ensureParents(target);
  files.set(target, "");
};

const deleteFile = async (target: string): Promise<void> => {
  if (files.delete(target)) return;
  if (!dirs.has(target)) throw new Error(`"${target}" does not exist.`);
  for (const dir of [...dirs]) if (dir === target || dir.startsWith(`${target}/`)) dirs.delete(dir);
  for (const filePath of [...files.keys()]) if (filePath.startsWith(`${target}/`)) files.delete(filePath);
};

const rename = async (oldPath: string, newPath: string): Promise<void> => {
  if (files.has(oldPath)) {
    ensureParents(newPath);
    files.set(newPath, files.get(oldPath) ?? "");
    files.delete(oldPath);
    return;
  }
  if (!dirs.has(oldPath)) throw new Error(`"${oldPath}" does not exist.`);
  ensureParents(newPath);
  for (const dir of [...dirs]) {
    if (dir !== oldPath && !dir.startsWith(`${oldPath}/`)) continue;
    dirs.delete(dir);
    dirs.add(`${newPath}${dir.slice(oldPath.length)}`);
  }
  for (const filePath of [...files.keys()]) {
    if (!filePath.startsWith(`${oldPath}/`)) continue;
    files.set(`${newPath}${filePath.slice(oldPath.length)}`, files.get(filePath) ?? "");
    files.delete(filePath);
  }
};

const readFile = async (filePath: string): Promise<string> => {
  const content = files.get(filePath);
  if (content === undefined) throw new Error(`"${filePath}" does not exist.`);
  return content;
};

const forge = {
  openFolder: async () => ROOT,
  listDir,
  createFile,
  deleteFile,
  rename,
  readFile,
  writeFile: async (filePath: string, content: string) => { files.set(filePath, content); },
};

let useWorkspaceStore: (typeof import("../../packages/client/src/stores/useWorkspaceStore"))["useWorkspaceStore"];

const state = () => useWorkspaceStore.getState();
const names = (nodes: FileNode[]) => nodes.map((node) => node.name);
const childrenOf = (path: string) => findNode(state().fileTree, path)?.children;

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = { forge };
  ({ useWorkspaceStore } = await import("../../packages/client/src/stores/useWorkspaceStore"));

  dirs.add(`${ROOT}/src`);
  dirs.add(`${ROOT}/src/deep`);
  files.set(`${ROOT}/readme.md`, "# hi\n");
  files.set(`${ROOT}/src/a.ts`, "export const a = 1;\n");
  files.set(`${ROOT}/src/deep/b.ts`, "export const b = 2;\n");

  await state().openFolder(ROOT);
});

test("opening a folder lists the root lazily", () => {
  expect(state().folderPath).toBe(ROOT);
  expect(names(state().fileTree)).toEqual(["src", "readme.md"]);
  expect(childrenOf(`${ROOT}/src`)).toBeUndefined();
});

test("creating a file at the root lists it and opens it", async () => {
  const created = await state().createEntry(null, "notes.md", false);
  expect(created).toBe(`${ROOT}/notes.md`);
  expect(names(state().fileTree)).toEqual(["src", "notes.md", "readme.md"]);
  expect(state().openTabs.map((tab) => tab.filePath)).toEqual([`${ROOT}/notes.md`]);
  expect(state().error).toBeNull();
});

test("creating a nested file expands every folder down to it", async () => {
  const created = await state().createEntry(null, "src/deep/c.ts", false);
  expect(created).toBe(`${ROOT}/src/deep/c.ts`);
  expect(childrenOf(`${ROOT}/src`)).toBeDefined();
  expect(names(childrenOf(`${ROOT}/src/deep`) ?? [])).toEqual(["b.ts", "c.ts"]);
  expect(state().openTabs.at(-1)?.filePath).toBe(`${ROOT}/src/deep/c.ts`);
  expect(state().openTabs.at(-1)?.language).toBe("typescript");
});

test("creating a folder shows it collapsed and opens no tab", async () => {
  const before = state().openTabs.length;
  const created = await state().createEntry(`${ROOT}/src`, "assets", true);
  expect(created).toBe(`${ROOT}/src/assets`);
  expect(childrenOf(`${ROOT}/src/assets`)).toBeUndefined();
  expect(names(childrenOf(`${ROOT}/src`) ?? [])).toEqual(["assets", "deep", "a.ts"]);
  expect(state().openTabs.length).toBe(before);
});

test("an unusable name is rejected without touching the disk", async () => {
  const count = files.size;
  expect(await state().createEntry(null, "..", false)).toBeNull();
  expect(await state().createEntry(null, "a//b.ts", false)).toBeNull();
  expect(state().error).toMatch(/empty path segments/);
  expect(files.size).toBe(count);
});

test("a failure from the main process reaches the error toast", async () => {
  expect(await state().createEntry(null, "readme.md", false)).toBeNull();
  expect(state().error).toMatch(/already exists/);
  state().clearError();
  expect(state().error).toBeNull();
});

test("renaming a file moves its open tab", async () => {
  await state().openFile(`${ROOT}/src/a.ts`);
  expect(state().openTabs.at(-1)?.filePath).toBe(`${ROOT}/src/a.ts`);

  const renamed = await state().renameEntry(`${ROOT}/src/a.ts`, "alpha.ts");
  expect(renamed).toBe(`${ROOT}/src/alpha.ts`);
  expect(state().openTabs.map((tab) => tab.filePath)).toContain(`${ROOT}/src/alpha.ts`);
  expect(state().openTabs.some((tab) => tab.filePath === `${ROOT}/src/a.ts`)).toBe(false);
  expect(names(childrenOf(`${ROOT}/src`) ?? [])).toEqual(["assets", "deep", "alpha.ts"]);
  expect(files.has(`${ROOT}/src/alpha.ts`)).toBe(true);
});

test("renaming a folder keeps it expanded and rewrites every path under it", async () => {
  await state().openFile(`${ROOT}/src/deep/b.ts`);
  state().collapseAll();
  await state().toggleDirectory(`${ROOT}/src`);
  await state().toggleDirectory(`${ROOT}/src/deep`);
  expect(names(childrenOf(`${ROOT}/src/deep`) ?? [])).toEqual(["b.ts", "c.ts"]);

  const renamed = await state().renameEntry(`${ROOT}/src/deep`, "nested");
  expect(renamed).toBe(`${ROOT}/src/nested`);
  expect(names(childrenOf(`${ROOT}/src`) ?? [])).toEqual(["assets", "nested", "alpha.ts"]);
  // still expanded, with rewritten children
  expect(names(childrenOf(`${ROOT}/src/nested`) ?? [])).toEqual(["b.ts", "c.ts"]);
  expect(state().openTabs.map((tab) => tab.filePath)).toContain(`${ROOT}/src/nested/b.ts`);
  expect(files.has(`${ROOT}/src/nested/b.ts`)).toBe(true);
});

test("renaming to the same name does nothing", async () => {
  expect(await state().renameEntry(`${ROOT}/src/alpha.ts`, "alpha.ts")).toBeNull();
  expect(state().error).toBeNull();
  expect(files.has(`${ROOT}/src/alpha.ts`)).toBe(true);
});

test("deleting a file closes its tab and refreshes its folder", async () => {
  expect(await state().deleteEntry(`${ROOT}/src/alpha.ts`)).toBe(true);
  expect(files.has(`${ROOT}/src/alpha.ts`)).toBe(false);
  expect(names(childrenOf(`${ROOT}/src`) ?? [])).toEqual(["assets", "nested"]);
  expect(state().openTabs.some((tab) => tab.filePath === `${ROOT}/src/alpha.ts`)).toBe(false);
});

test("deleting a folder closes every tab inside it", async () => {
  await state().openFile(`${ROOT}/src/nested/b.ts`);
  await state().openFile(`${ROOT}/src/nested/c.ts`);
  const inside = state().openTabs.filter((tab) => tab.filePath.startsWith(`${ROOT}/src/nested`));
  expect(inside.length).toBe(2);

  expect(await state().deleteEntry(`${ROOT}/src/nested`)).toBe(true);
  // the tab that was never inside the folder survives and becomes active
  expect(state().openTabs.map((tab) => tab.filePath)).toEqual([`${ROOT}/notes.md`]);
  expect(state().activeTabId).toBe(state().openTabs[0].id);
  for (const tab of inside) expect(state().contents[tab.id]).toBeUndefined();
  expect(names(childrenOf(`${ROOT}/src`) ?? [])).toEqual(["assets"]);
});

test("refreshTree picks up external changes without collapsing anything", async () => {
  state().collapseAll();
  await state().toggleDirectory(`${ROOT}/src`);
  files.set(`${ROOT}/src/external.ts`, "// written by something else\n");

  await state().refreshTree();
  expect(names(childrenOf(`${ROOT}/src`) ?? [])).toEqual(["assets", "external.ts"]);
  expect(childrenOf(`${ROOT}/src`)).toBeDefined();

  state().collapseAll();
  expect(childrenOf(`${ROOT}/src`)).toBeUndefined();
});

test("operations without a folder are no-ops", async () => {
  const folderPath = state().folderPath;
  useWorkspaceStore.setState({ folderPath: null });
  expect(await state().createEntry(null, "x.ts", false)).toBeNull();
  expect(await state().renameEntry("/somewhere/x.ts", "y.ts")).toBeNull();
  expect(await state().deleteEntry("/somewhere/x.ts")).toBe(false);
  useWorkspaceStore.setState({ folderPath });
});
