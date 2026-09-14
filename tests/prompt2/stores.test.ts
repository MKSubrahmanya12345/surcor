import { beforeAll, expect, mock, test } from "bun:test";
import type { GitHubRepo } from "@forge/shared";

const calls: { name: string; args: unknown[] }[] = [];
const openedFolders: (string | undefined)[] = [];

mock.module("../../packages/client/src/stores/useWorkspaceStore", () => ({
  useWorkspaceStore: {
    getState: () => ({
      folderPath: "/workspace",
      openFolder: async (path?: string) => {
        openedFolders.push(path);
      },
    }),
  },
}));

const forge = {
  openFolder: async () => "/chosen/parent",
  gitClone: async (options: unknown) => {
    calls.push({ name: "gitClone", args: [options] });
    return { ok: true, message: "Cloned.", repoPath: "/chosen/parent/repo" };
  },
  gitStatus: async () => ({ isRepository: true, repoPath: "/workspace", branch: "main", detached: false, tracking: "origin/main", ahead: 0, behind: 0, files: [] }),
  gitDiff: async () => ({ filePath: "", absolutePath: "", staged: false, isUntracked: false, isBinary: false, original: "", modified: "", truncated: false }),
  gitCommit: async (options: unknown) => {
    calls.push({ name: "gitCommit", args: [options] });
    return { ok: true, message: "Committed abc1234 on main — 1 file(s) changed." };
  },
  gitPush: async () => {
    calls.push({ name: "gitPush", args: [] });
    return { ok: true, message: "Pushed main to origin/main." };
  },
  gitPull: async () => ({ ok: true, message: "Already up to date." }),
  gitBranch: async () => ({ isRepository: true, branch: "main", detached: false, branches: ["main"], tracking: "origin/main", ahead: 0, behind: 0 }),
  gitStage: async () => ({ ok: true, message: "Staged 1 file(s)." }),
  gitUnstage: async () => ({ ok: true, message: "Unstaged 1 file(s)." }),
  gitDiscard: async () => ({ ok: true, message: "Discarded changes in 1 file(s)." }),
};

const repo: GitHubRepo = {
  id: 1,
  name: "repo",
  fullName: "octoforge/repo",
  private: false,
  cloneUrl: "https://github.com/octoforge/repo.git",
  htmlUrl: "https://github.com/octoforge/repo",
  description: null,
  defaultBranch: "main",
  updatedAt: null,
  language: null,
};

let useGitHubStore: (typeof import("../../packages/client/src/stores/useGitHubStore"))["useGitHubStore"];
let useGitStore: (typeof import("../../packages/client/src/stores/useGitStore"))["useGitStore"];

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = { forge };
  ({ useGitHubStore } = await import("../../packages/client/src/stores/useGitHubStore"));
  ({ useGitStore } = await import("../../packages/client/src/stores/useGitStore"));
});

test("cloning a repository hands the new folder to useWorkspaceStore.openFolder", async () => {
  calls.length = 0;
  openedFolders.length = 0;

  await useGitHubStore.getState().clone(repo);

  // one and only one folder-opening code path: the workspace store's
  expect(calls.map((call) => call.name)).toEqual(["gitClone"]);
  expect(calls[0]!.args[0]).toEqual({
    url: "https://github.com/octoforge/repo.git",
    parentDir: "/chosen/parent",
    directory: "repo",
  });
  expect(openedFolders).toEqual(["/chosen/parent/repo"]);
  expect(useGitHubStore.getState().cloningRepo).toBeNull();
});

test("cancelling the folder picker aborts the clone", async () => {
  const original = forge.openFolder;
  forge.openFolder = async () => null;
  calls.length = 0;
  openedFolders.length = 0;

  await useGitHubStore.getState().clone(repo);

  expect(calls).toEqual([]);
  expect(openedFolders).toEqual([]);
  forge.openFolder = original;
});

test("a failed clone reports the error and does not switch folders", async () => {
  const original = forge.gitClone;
  forge.gitClone = async () => ({ ok: false, message: "repository not found", repoPath: "/chosen/parent/repo" });
  openedFolders.length = 0;

  await useGitHubStore.getState().clone(repo);

  expect(useGitHubStore.getState().error).toBe("repository not found");
  expect(openedFolders).toEqual([]);
  forge.gitClone = original;
});

test("Commit & Push commits, pushes once, and refreshes the tree", async () => {
  calls.length = 0;
  const ok = await useGitStore.getState().commit("ship it", true);

  expect(ok).toBe(true);
  expect(calls.map((call) => call.name)).toEqual(["gitCommit", "gitPush"]);
  expect(calls[0]!.args[0]).toEqual({ repoPath: "/workspace", message: "ship it" });
  expect(useGitStore.getState().notice).toContain("Pushed");
  expect(useGitStore.getState().status?.branch).toBe("main");
});

test("a failed commit keeps the message box usable by reporting an error", async () => {
  const original = forge.gitCommit;
  forge.gitCommit = async () => ({ ok: false, message: "nothing to commit" });

  const ok = await useGitStore.getState().commit("empty", false);

  expect(ok).toBe(false);
  expect(useGitStore.getState().error).toBe("nothing to commit");
  forge.gitCommit = original;
});
