import { expect, test } from "bun:test";
import {
  baseName,
  clearChildren,
  dirName,
  findNode,
  hasNode,
  isInside,
  joinPath,
  nearestKnownAncestor,
  remapSubtree,
  replacePrefix,
  separatorFor,
  validateEntryName,
} from "../../packages/client/src/components/FileTree/treeOps";
import type { FileNode } from "@forge/shared";

const dir = (path: string, children?: FileNode[]): FileNode =>
  ({ path, name: path.split(/[\\/]/).pop() ?? path, isDirectory: true, ...(children ? { children } : {}) });
const file = (path: string): FileNode =>
  ({ path, name: path.split(/[\\/]/).pop() ?? path, isDirectory: false });

test("separatorFor reads the separator the path was produced with", () => {
  expect(separatorFor("/home/user/project")).toBe("/");
  expect(separatorFor("C:\\Users\\me\\project")).toBe("\\");
  expect(separatorFor("plain-name")).toBe("/");
});

test("baseName / dirName / joinPath round-trip", () => {
  expect(baseName("/a/b/c.ts")).toBe("c.ts");
  expect(baseName("C:\\a\\b\\c.ts", "\\")).toBe("c.ts");
  expect(dirName("/a/b/c.ts")).toBe("/a/b");
  expect(dirName("/a")).toBe("/");
  expect(dirName("C:\\a\\b", "\\")).toBe("C:\\a");
  expect(dirName("C:\\a", "\\")).toBe("C:\\");
  expect(joinPath("/a/b", "c.ts")).toBe("/a/b/c.ts");
  expect(joinPath("/", "c.ts")).toBe("/c.ts");
  expect(joinPath("C:\\a", "b.ts", "\\")).toBe("C:\\a\\b.ts");
});

test("isInside is prefix-safe at directory boundaries", () => {
  expect(isInside("/a/b", "/a/b")).toBe(true);
  expect(isInside("/a/b", "/a/b/c.ts")).toBe(true);
  expect(isInside("/a/b", "/a/bc.ts")).toBe(false);
  expect(isInside("/a/b", "/a/c.ts")).toBe(false);
  expect(isInside("C:\\a\\b", "C:\\a\\b\\c.ts", "\\")).toBe(true);
  expect(isInside("C:\\a\\b", "C:\\a\\bc.ts", "\\")).toBe(false);
});

test("replacePrefix only rewrites paths under the old prefix", () => {
  expect(replacePrefix("/a/b/c.ts", "/a/b", "/x/y")).toBe("/x/y/c.ts");
  expect(replacePrefix("/a/b", "/a/b", "/x/y")).toBe("/x/y");
  expect(replacePrefix("/a/z/c.ts", "/a/b", "/x/y")).toBeNull();
});

test("validateEntryName accepts ordinary and nested names", () => {
  expect(validateEntryName("main.ts", { isWindows: false })).toBeNull();
  expect(validateEntryName("src/components/New.tsx", { isWindows: false })).toBeNull();
  expect(validateEntryName("  spaced name  ", { isWindows: false })).toBeNull();
});

test("validateEntryName rejects unusable names", () => {
  expect(validateEntryName("", { isWindows: false })).toMatch(/Enter a name/);
  expect(validateEntryName("   ", { isWindows: false })).toMatch(/Enter a name/);
  expect(validateEntryName(".", { isWindows: false })).toMatch(/cannot be '\.' or '\.\.'/);
  expect(validateEntryName("..", { isWindows: false })).toMatch(/cannot be '\.' or '\.\.'/);
  expect(validateEntryName("src/./a.ts", { isWindows: false })).toMatch(/cannot be '\.' or '\.\.'/);
  expect(validateEntryName("src//double.ts", { isWindows: false })).toMatch(/empty path segments/);
  expect(validateEntryName("/leading-slash.ts", { isWindows: false })).toMatch(/empty path segments/);
  expect(validateEntryName("bad\nname.ts", { isWindows: false })).toMatch(/control characters/);
  expect(validateEntryName("x".repeat(256), { isWindows: false })).toMatch(/too long/);
});

test("validateEntryName applies Windows rules only on Windows", () => {
  expect(validateEntryName('weird<>:"|?*.ts', { isWindows: false })).toBeNull();
  expect(validateEntryName("weird?.ts", { isWindows: true })).toMatch(/Windows/);
  expect(validateEntryName("CON", { isWindows: true })).toMatch(/reserved device name/);
  expect(validateEntryName("con.txt", { isWindows: true })).toMatch(/reserved device name/);
  expect(validateEntryName("COM9.log", { isWindows: true })).toMatch(/reserved device name/);
  expect(validateEntryName("trailing.", { isWindows: true })).toMatch(/dot or a space/);
  expect(validateEntryName("src\\nested\\file.ts", { isWindows: true })).toBeNull();
});

test("findNode / hasNode walk expanded children only", () => {
  const tree: FileNode[] = [
    dir("/w/src", [file("/w/src/a.ts"), dir("/w/src/deep", [file("/w/src/deep/b.ts")])]),
    file("/w/readme.md"),
  ];
  expect(findNode(tree, "/w/src/deep/b.ts")?.name).toBe("b.ts");
  expect(findNode(tree, "/w/missing.ts")).toBeUndefined();
  expect(hasNode(tree, "/w/readme.md")).toBe(true);
  expect(hasNode(tree, "/w/src/collapsed")).toBe(false);
});

test("clearChildren collapses every level", () => {
  const tree: FileNode[] = [dir("/w/src", [dir("/w/src/deep", [file("/w/src/deep/b.ts")])]), file("/w/x.ts")];
  const collapsed = clearChildren(tree);
  expect(collapsed[0].children).toBeUndefined();
  expect(collapsed[1].children).toBeUndefined();
  expect(collapsed[0].path).toBe("/w/src");
});

test("nearestKnownAncestor finds the deepest loaded directory", () => {
  const tree: FileNode[] = [dir("/w/src", [dir("/w/src/deep")]), file("/w/x.ts")];
  expect(nearestKnownAncestor(tree, "/w/src/deep/new.ts")).toBe("/w/src/deep");
  expect(nearestKnownAncestor(tree, "/w/src/other/new.ts")).toBe("/w/src");
  expect(nearestKnownAncestor(tree, "/w/top-level.ts")).toBeNull();
  const windows: FileNode[] = [dir("C:\\w\\src")];
  expect(nearestKnownAncestor(windows, "C:\\w\\src\\a.ts", "\\")).toBe("C:\\w\\src");
  expect(nearestKnownAncestor(windows, "C:\\w\\other\\a.ts", "\\")).toBeNull();
});

test("remapSubtree renames a top-level folder and rewrites what is under it", () => {
  const tree: FileNode[] = [
    dir("/w/src", [file("/w/src/a.ts"), dir("/w/src/deep", [file("/w/src/deep/b.ts")])]),
    file("/w/readme.md"),
  ];
  const remapped = remapSubtree(tree, "/w/src", "/w/lib");
  expect(remapped.map((node) => node.path)).toEqual(["/w/lib", "/w/readme.md"]);
  expect(remapped[0].name).toBe("lib");
  expect(remapped[0].children?.map((node) => node.path)).toEqual(["/w/lib/a.ts", "/w/lib/deep"]);
  expect(remapped[0].children?.[1].children?.[0].path).toBe("/w/lib/deep/b.ts");
});

test("remapSubtree finds a renamed folder deeper in the tree", () => {
  const tree: FileNode[] = [dir("/w/src", [dir("/w/src/deep", [file("/w/src/deep/b.ts")])])];
  const remapped = remapSubtree(tree, "/w/src/deep", "/w/src/nested");
  expect(remapped[0].path).toBe("/w/src");
  expect(remapped[0].children?.[0].path).toBe("/w/src/nested");
  expect(remapped[0].children?.[0].name).toBe("nested");
  expect(remapped[0].children?.[0].children?.[0].path).toBe("/w/src/nested/b.ts");
});

test("remapSubtree leaves unrelated branches untouched (expansion survives)", () => {
  const other = dir("/w/other", [file("/w/other/a.ts")]);
  const tree: FileNode[] = [dir("/w/src"), other];
  const remapped = remapSubtree(tree, "/w/src", "/w/lib");
  expect(remapped[1]).toBe(other);
});

test("remapSubtree ignores paths outside the renamed prefix", () => {
  const tree: FileNode[] = [file("/w/other/a.ts")];
  expect(remapSubtree(tree, "/w/src", "/w/lib")).toBe(tree);
});
