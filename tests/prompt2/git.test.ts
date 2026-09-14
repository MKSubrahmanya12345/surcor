import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IPC } from "@forge/shared";
import type { GitBranchInfo, GitCloneResult, GitDiff, GitOperationResult, GitStatusSummary } from "@forge/shared";
import { handlers, installElectronMock } from "./harness";

installElectronMock();

const root = mkdtempSync(`${tmpdir()}/forge-git-`);
const repo = path.join(root, "workspace");
const bare = path.join(root, "origin.git");
const cloneParent = path.join(root, "clones");
const git = (args: string[], cwd = repo) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

beforeAll(async () => {
  mkdirSync(repo, { recursive: true });
  mkdirSync(cloneParent, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  git(["config", "user.email", "forge@example.com"]);
  git(["config", "user.name", "Forge"]);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { cwd: root, stdio: "ignore" });

  writeFileSync(path.join(repo, "tracked.txt"), "one\ntwo\nthree\n");
  writeFileSync(path.join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3, 255]));
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
  git(["remote", "add", "origin", bare]);

  // dirty the worktree: modify tracked, add untracked, delete a file
  writeFileSync(path.join(repo, "tracked.txt"), "one\nTWO\nthree\nfour\n");
  writeFileSync(path.join(repo, "new-file.txt"), "brand new\n");
  writeFileSync(path.join(repo, "binary.bin"), Buffer.from([0, 9, 9, 3, 255]));

  const { registerGitHandlers } = await import("../../packages/client/electron/ipc/git");
  registerGitHandlers();
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("registers every git channel", () => {
  for (const channel of [IPC.GIT_STATUS, IPC.GIT_DIFF, IPC.GIT_COMMIT, IPC.GIT_PUSH, IPC.GIT_PULL, IPC.GIT_CLONE, IPC.GIT_BRANCH]) {
    expect(handlers.has(channel)).toBe(true);
  }
});

test("git:status reports branch, untracked, modified and staged files", async () => {
  const status = await invoke<GitStatusSummary>(IPC.GIT_STATUS, { repoPath: repo });
  expect(status.isRepository).toBe(true);
  expect(status.branch).toBe("main");
  expect(status.files.map((f) => `${f.path}:${f.status}:${f.staged}`).sort()).toEqual([
    "binary.bin:modified:false",
    "new-file.txt:untracked:false",
    "tracked.txt:modified:false",
  ]);
});

test("git:status is empty for a non-repository", async () => {
  const plain = mkdtempSync(`${tmpdir()}/forge-plain-`);
  const status = await invoke<GitStatusSummary>(IPC.GIT_STATUS, { repoPath: plain });
  expect(status.isRepository).toBe(false);
  expect(status.files).toEqual([]);
  rmSync(plain, { recursive: true, force: true });
});

test("git:diff shows HEAD vs worktree for an unstaged file", async () => {
  const diff = await invoke<GitDiff>(IPC.GIT_DIFF, { repoPath: repo, filePath: "tracked.txt", staged: false });
  expect(diff.isUntracked).toBe(false);
  expect(diff.original).toBe("one\ntwo\nthree\n");
  expect(diff.modified).toBe("one\nTWO\nthree\nfour\n");
});

test("git:diff shows the whole file for an untracked file", async () => {
  const diff = await invoke<GitDiff>(IPC.GIT_DIFF, { repoPath: repo, filePath: "new-file.txt", staged: false });
  expect(diff.isUntracked).toBe(true);
  expect(diff.original).toBe("");
  expect(diff.modified).toBe("brand new\n");
});

test("git:diff flags binary files instead of dumping bytes", async () => {
  const diff = await invoke<GitDiff>(IPC.GIT_DIFF, { repoPath: repo, filePath: "binary.bin", staged: false });
  expect(diff.isBinary).toBe(true);
  expect(diff.modified).toBe("");
});

test("git:stage moves a file into the index and git:unstage takes it back out", async () => {
  const staged = await invoke<GitOperationResult>(IPC.GIT_STAGE, { repoPath: repo, paths: ["new-file.txt"] });
  expect(staged.ok).toBe(true);

  let status = await invoke<GitStatusSummary>(IPC.GIT_STATUS, { repoPath: repo });
  expect(status.files.find((f) => f.path === "new-file.txt" && f.staged)).toBeTruthy();

  const diff = await invoke<GitDiff>(IPC.GIT_DIFF, { repoPath: repo, filePath: "new-file.txt", staged: true });
  expect(diff.original).toBe("");
  expect(diff.modified).toBe("brand new\n");

  const unstaged = await invoke<GitOperationResult>(IPC.GIT_UNSTAGE, { repoPath: repo, paths: ["new-file.txt"] });
  expect(unstaged.ok).toBe(true);

  status = await invoke<GitStatusSummary>(IPC.GIT_STATUS, { repoPath: repo });
  expect(status.files.find((f) => f.path === "new-file.txt" && f.staged)).toBeUndefined();
});

test("git:discard restores tracked files but refuses to delete untracked ones", async () => {
  const discardTracked = await invoke<GitOperationResult>(IPC.GIT_DISCARD, { repoPath: repo, paths: ["tracked.txt"] });
  expect(discardTracked.ok).toBe(true);
  expect(readFileSync(path.join(repo, "tracked.txt"), "utf8")).toBe("one\ntwo\nthree\n");

  const discardUntracked = await invoke<GitOperationResult>(IPC.GIT_DISCARD, { repoPath: repo, paths: ["new-file.txt"] });
  expect(discardUntracked.ok).toBe(false);
  expect(discardUntracked.message).toContain("untracked");
});

test("git:commit commits staged work and reports the sha", async () => {
  writeFileSync(path.join(repo, "committed.txt"), "hello commit\n");
  const result = await invoke<GitOperationResult>(IPC.GIT_COMMIT, { repoPath: repo, message: "add committed.txt" });
  expect(result.ok).toBe(true);
  expect(result.message).toContain("Committed");

  const log = git(["log", "--oneline"]);
  expect(log).toContain("add committed.txt");

  const status = await invoke<GitStatusSummary>(IPC.GIT_STATUS, { repoPath: repo });
  expect(status.files.find((f) => f.path === "committed.txt")).toBeUndefined();
});

test("git:commit returns ok:false with git's message when there is nothing to commit", async () => {
  // the previous test already committed everything, so this has nothing to do
  const result = await invoke<GitOperationResult>(IPC.GIT_COMMIT, { repoPath: repo, message: "empty" });
  expect(result.ok).toBe(false);
  expect(result.message.length).toBeGreaterThan(0);
});

test("git:push publishes to the bare remote and git:branch shows tracking", async () => {
  const push = await invoke<GitOperationResult>(IPC.GIT_PUSH, { repoPath: repo });
  expect(push.ok).toBe(true);

  const branch = await invoke<GitBranchInfo>(IPC.GIT_BRANCH, { repoPath: repo });
  expect(branch.isRepository).toBe(true);
  expect(branch.branch).toBe("main");
  expect(branch.tracking).toBe("origin/main");
  expect(branch.branches).toContain("main");

  const secondPush = await invoke<GitOperationResult>(IPC.GIT_PUSH, { repoPath: repo });
  expect(secondPush.ok).toBe(true);
  expect(secondPush.message).toMatch(/up-to-date|Up-to-date|Pushed/);
});

test("git:pull is a no-op when already up to date", async () => {
  const pull = await invoke<GitOperationResult>(IPC.GIT_PULL, { repoPath: repo });
  expect(pull.ok).toBe(true);
  expect(pull.message).toBe("Already up to date.");
});

test("git:clone clones the bare repo into the chosen parent folder", async () => {
  const result = await invoke<GitCloneResult>(IPC.GIT_CLONE, { url: bare, parentDir: cloneParent });
  expect(result.ok).toBe(true);
  // ".git" is stripped from the source name, like every other git client
  expect(result.repoPath).toBe(path.join(cloneParent, "origin"));
  expect(readFileSync(path.join(result.repoPath, "tracked.txt"), "utf8")).toBe("one\ntwo\nthree\n");

  const again = await invoke<GitCloneResult>(IPC.GIT_CLONE, { url: bare, parentDir: cloneParent, directory: "origin" });
  expect(again.ok).toBe(false);
  expect(again.message).toContain("not empty");
});

function invoke<T>(channel: string, payload: unknown): Promise<T> {
  const handler = handlers.get(channel)!;
  return Promise.resolve(handler({}, payload) as T);
}
