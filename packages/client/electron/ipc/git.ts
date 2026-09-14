import { ipcMain } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { simpleGit, type SimpleGit } from "simple-git";
import {
  IPC,
  type GitBranchInfo,
  type GitDiff,
  type GitFileStatus,
  type GitFileStatusCode,
  type GitStatusSummary,
} from "@forge/shared";
import { getGitHubToken } from "./github";

const MAX_DIFF_BYTES = 2 * 1024 * 1024; // 2 MB per side, keeps Monaco responsive

const repoPayload = z.object({ repoPath: z.string().min(1) }).strict();

const diffPayload = z
  .object({
    repoPath: z.string().min(1),
    filePath: z.string().min(1),
    staged: z.boolean().default(false),
  })
  .strict();

const pathsPayload = z
  .object({ repoPath: z.string().min(1), paths: z.array(z.string().min(1)).min(1) })
  .strict();

const commitPayload = z
  .object({
    repoPath: z.string().min(1),
    message: z.string().min(1),
    stageAll: z.boolean().default(false),
  })
  .strict();

const pushPayload = z
  .object({
    repoPath: z.string().min(1),
    remote: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
  })
  .strict();

const pullPayload = z
  .object({
    repoPath: z.string().min(1),
    remote: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
  })
  .strict();

// clone sources can be https URLs, ssh remotes (git@host:org/repo.git) or
// local paths, so this is deliberately looser than a URL check — git itself
// reports anything it cannot use.
const clonePayload = z
  .object({
    url: z.string().min(1),
    parentDir: z.string().min(1),
    directory: z.string().min(1).optional(),
  })
  .strict();

const gitFor = (() => {
  const instances = new Map<string, SimpleGit>();
  return (repoPath: string): SimpleGit => {
    const existing = instances.get(repoPath);
    if (existing) return existing;
    const instance = simpleGit({ baseDir: repoPath, binary: "git", maxConcurrentProcesses: 4 });
    instances.set(repoPath, instance);
    return instance;
  };
})();

const errorMessage = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitize(raw).split("\n").filter(Boolean).slice(0, 6).join("\n").trim();
};

/** Never let a GitHub token leak into an error message shown in the UI. */
function sanitize(text: string): string {
  return text.replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");
}

const codeToStatus = (code: string): GitFileStatusCode => {
  switch (code) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "unmerged";
    case "?":
      return "untracked";
    default:
      return "unknown";
  }
};

const normalizeCode = (code: string | undefined): string => {
  const trimmed = (code ?? " ").trim();
  return trimmed.length > 0 ? trimmed : " ";
};

async function isRepository(git: SimpleGit): Promise<boolean> {
  try {
    return await git.checkIsRepo();
  } catch {
    return false;
  }
}

function toFileStatuses(
  files: { path: string; index: string; working_dir: string; from?: string }[],
  repoPath: string,
): GitFileStatus[] {
  const result: GitFileStatus[] = [];
  for (const file of files) {
    const indexStatus = normalizeCode(file.index);
    const workingDirStatus = normalizeCode(file.working_dir);
    const base = {
      path: file.path,
      absolutePath: path.join(repoPath, file.path),
      indexStatus,
      workingDirStatus,
      renamedFrom: file.from,
    };

    // A file with both staged and unstaged edits shows up in both lists,
    // exactly like it does in VS Code.
    if (workingDirStatus !== " " && workingDirStatus !== "?") {
      result.push({ ...base, status: codeToStatus(workingDirStatus), staged: false });
    }
    if (indexStatus !== " " && indexStatus !== "?") {
      result.push({ ...base, status: codeToStatus(indexStatus), staged: true });
    }
    if (indexStatus === "?" && workingDirStatus === "?") {
      result.push({ ...base, status: "untracked", staged: false });
    }
  }
  return result.sort((a, b) => {
    if (a.path === b.path) return Number(a.staged) - Number(b.staged);
    return a.path.localeCompare(b.path);
  });
}

const emptySummary = (repoPath: string): GitStatusSummary => ({
  isRepository: false,
  repoPath,
  branch: null,
  detached: false,
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
});

async function readStatus(repoPath: string): Promise<GitStatusSummary> {
  const git = gitFor(repoPath);
  if (!(await isRepository(git))) return emptySummary(repoPath);

  const status = await git.status(["-uall"]);
  return {
    isRepository: true,
    repoPath,
    branch: status.current,
    detached: status.detached,
    tracking: status.tracking,
    ahead: Number.isFinite(status.ahead) ? status.ahead : 0,
    behind: Number.isFinite(status.behind) ? status.behind : 0,
    files: toFileStatuses(status.files, repoPath),
  };
}

/**
 * Reads one side of a diff straight out of git's object store.
 * `spec` is a revision-qualified path: `HEAD:src/a.ts` (committed) or
 * `:src/a.ts` (index / staged).
 */
async function showFile(git: SimpleGit, spec: string): Promise<string | null> {
  try {
    const content = await git.show([spec]);
    return typeof content === "string" ? content : null;
  } catch {
    return null; // path missing from that ref (new, deleted or renamed)
  }
}

async function readWorktreeFile(absolutePath: string): Promise<{ content: string; truncated: boolean }> {
  try {
    const stat = await fs.stat(absolutePath);
    const truncated = stat.size > MAX_DIFF_BYTES;
    if (truncated) {
      const handle = await fs.open(absolutePath, "r");
      try {
        const buffer = Buffer.alloc(MAX_DIFF_BYTES);
        await handle.read(buffer, 0, MAX_DIFF_BYTES, 0);
        return { content: buffer.toString("utf8"), truncated };
      } finally {
        await handle.close();
      }
    }
    return { content: await fs.readFile(absolutePath, "utf8"), truncated: false };
  } catch {
    return { content: "", truncated: false }; // deleted from the worktree
  }
}

async function readDiff(repoPath: string, filePath: string, staged: boolean): Promise<GitDiff> {
  const git = gitFor(repoPath);
  const absolutePath = path.join(repoPath, filePath);
  const base = { filePath, absolutePath, staged, isUntracked: false, isBinary: false };

  const status = await git.status(["-uall"]);
  const entry = status.files.find((file) => file.path === filePath);
  const indexStatus = normalizeCode(entry?.index);
  const workingDirStatus = normalizeCode(entry?.working_dir);
  const isUntracked = indexStatus === "?" && workingDirStatus === "?";

  if (isUntracked) {
    const { content, truncated } = await readWorktreeFile(absolutePath);
    return { ...base, isUntracked: true, original: "", modified: content, truncated };
  }

  const numstatArgs = staged
    ? ["--cached", "--numstat", "--", filePath]
    : ["--numstat", "--", filePath];
  let isBinary = false;
  try {
    const numstat = await git.diff(numstatArgs);
    isBinary = numstat.trim().startsWith("-\t-");
  } catch {
    isBinary = false;
  }

  if (isBinary) {
    return { ...base, isBinary: true, original: "", modified: "", truncated: false };
  }

  // staged  -> HEAD vs index   |   unstaged -> index vs worktree
  const original = (staged ? await showFile(git, `HEAD:${filePath}`) : await showFile(git, `:${filePath}`)) ?? "";
  const modified = staged
    ? ((await showFile(git, `:${filePath}`)) ?? "")
    : (await readWorktreeFile(absolutePath)).content;

  const truncated = modified.length >= MAX_DIFF_BYTES || original.length >= MAX_DIFF_BYTES;
  return { ...base, original, modified, truncated };
}

async function discardPaths(repoPath: string, filePaths: string[]): Promise<string> {
  const git = gitFor(repoPath);
  const status = await git.status(["-uall"]);
  const tracked: string[] = [];
  const untracked: string[] = [];

  for (const filePath of filePaths) {
    const entry = status.files.find((file) => file.path === filePath);
    const codes = [normalizeCode(entry?.index), normalizeCode(entry?.working_dir)];
    if (codes.every((code) => code === "?" || code === " ")) untracked.push(filePath);
    else tracked.push(filePath);
  }

  if (tracked.length > 0) {
    try {
      await git.raw(["restore", "--worktree", "--", ...tracked]);
    } catch {
      await git.raw(["checkout", "--", ...tracked]);
    }
  }

  if (untracked.length > 0) {
    // Deleting user files automatically is never safe — ask them to do it.
    throw new Error(
      `Cannot discard untracked file(s): ${untracked.join(", ")}. Delete them manually.`,
    );
  }

  return `Discarded changes in ${tracked.length} file(s).`;
}

export function registerGitHandlers(): void {
  ipcMain.handle(IPC.GIT_STATUS, async (_event, payload: unknown) => {
    const { repoPath } = repoPayload.parse(payload);
    try {
      return await readStatus(repoPath);
    } catch {
      return emptySummary(repoPath);
    }
  });

  ipcMain.handle(IPC.GIT_DIFF, async (_event, payload: unknown) => {
    const { repoPath, filePath, staged } = diffPayload.parse(payload);
    try {
      return await readDiff(repoPath, filePath, staged);
    } catch {
      return {
        filePath,
        absolutePath: path.join(repoPath, filePath),
        staged,
        isUntracked: false,
        isBinary: false,
        original: "",
        modified: "",
        truncated: false,
      } satisfies GitDiff;
    }
  });

  ipcMain.handle(IPC.GIT_STAGE, async (_event, payload: unknown): Promise<{ ok: boolean; message: string }> => {
    const { repoPath, paths } = pathsPayload.parse(payload);
    try {
      await gitFor(repoPath).add(paths);
      return { ok: true, message: `Staged ${paths.length} file(s).` };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  });

  ipcMain.handle(IPC.GIT_UNSTAGE, async (_event, payload: unknown): Promise<{ ok: boolean; message: string }> => {
    const { repoPath, paths } = pathsPayload.parse(payload);
    const git = gitFor(repoPath);
    try {
      await git.raw(["restore", "--staged", "--", ...paths]);
    } catch {
      // `git restore` needs git >= 2.23 — fall back to a mixed reset.
      try {
        await git.reset(["--", ...paths]);
      } catch (error) {
        return { ok: false, message: errorMessage(error) };
      }
    }
    return { ok: true, message: `Unstaged ${paths.length} file(s).` };
  });

  ipcMain.handle(IPC.GIT_DISCARD, async (_event, payload: unknown): Promise<{ ok: boolean; message: string }> => {
    const { repoPath, paths } = pathsPayload.parse(payload);
    try {
      return { ok: true, message: await discardPaths(repoPath, paths) };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  });

  ipcMain.handle(IPC.GIT_COMMIT, async (_event, payload: unknown): Promise<{ ok: boolean; message: string }> => {
    const { repoPath, message, stageAll } = commitPayload.parse(payload);
    try {
      const git = gitFor(repoPath);
      const status = await git.status(["-uall"]);
      const hasStaged = status.files.some((file) =>
        ["M", "A", "D", "R", "C"].includes(normalizeCode(file.index)),
      );
      // Mirror VS Code: with nothing staged, a commit takes everything.
      if (stageAll || !hasStaged) await git.add(".");

      // simple-git resolves with an empty CommitResult instead of throwing
      // when there is nothing to commit, so check the tree ourselves.
      const pending = await git.status(["-uall"]);
      if (pending.files.length === 0) return { ok: false, message: "No changes to commit." };

      const result = await git.commit(message.trim());
      if (!result.commit) return { ok: false, message: "No changes to commit." };

      return {
        ok: true,
        message: `Committed ${result.commit.slice(0, 7)} on ${result.branch} — ${result.summary.changes} file(s) changed.`,
      };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  });

  ipcMain.handle(IPC.GIT_PUSH, async (_event, payload: unknown): Promise<{ ok: boolean; message: string }> => {
    const { repoPath, remote, branch } = pushPayload.parse(payload);
    try {
      const git = gitFor(repoPath);
      const status = await git.status();
      const targetBranch = branch ?? status.current;
      if (!targetBranch) return { ok: false, message: "Cannot push from a detached HEAD." };

      const remotes = await git.getRemotes(true);
      if (remotes.length === 0) {
        return { ok: false, message: "No git remote configured. Add one with `git remote add origin <url>`." };
      }

      if (status.tracking && !remote) {
        const result = await git.push();
        const pushed = result.pushed?.[0];
        return {
          ok: true,
          message: pushed?.alreadyUpdated
            ? "Everything up-to-date."
            : `Pushed ${targetBranch} to ${status.tracking}.`,
        };
      }

      const targetRemote =
        remote ?? (remotes.some((item) => item.name === "origin") ? "origin" : remotes[0]!.name);
      await git.push(targetRemote, targetBranch, ["--set-upstream"]);
      return { ok: true, message: `Pushed ${targetBranch} to ${targetRemote} (upstream set).` };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  });

  ipcMain.handle(IPC.GIT_PULL, async (_event, payload: unknown): Promise<{ ok: boolean; message: string }> => {
    const { repoPath, remote, branch } = pullPayload.parse(payload);
    try {
      const result = await gitFor(repoPath).pull(remote, branch);
      const changes = result?.summary?.changes ?? 0;
      return {
        ok: true,
        message: changes > 0 ? `Pulled ${changes} file change(s).` : "Already up to date.",
      };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  });

  ipcMain.handle(
    IPC.GIT_CLONE,
    async (_event, payload: unknown): Promise<{ ok: boolean; message: string; repoPath: string }> => {
      const { url, parentDir, directory } = clonePayload.parse(payload);
      const repoName = url
        .replace(/\.git\/?$/, "")
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop();
      const target = path.join(parentDir, directory ?? repoName ?? "repository");

      try {
        const targetEntries = await fs.readdir(target).catch(() => [] as string[]);
        if (targetEntries.length > 0) {
          return { ok: false, message: `${target} already exists and is not empty.`, repoPath: target };
        }

        await fs.mkdir(parentDir, { recursive: true });
        const cloneUrl = withCredentials(url, getGitHubToken());
        await simpleGit().clone(cloneUrl, target);
        return { ok: true, message: `Cloned into ${target}.`, repoPath: target };
      } catch (error) {
        return { ok: false, message: errorMessage(error), repoPath: target };
      }
    },
  );

  ipcMain.handle(IPC.GIT_BRANCH, async (_event, payload: unknown): Promise<GitBranchInfo> => {
    const { repoPath } = repoPayload.parse(payload);
    const empty: GitBranchInfo = {
      isRepository: false,
      branch: null,
      detached: false,
      branches: [],
      tracking: null,
      ahead: 0,
      behind: 0,
    };
    try {
      const git = gitFor(repoPath);
      if (!(await isRepository(git))) return empty;
      const [status, branches] = await Promise.all([git.status(), git.branchLocal()]);
      return {
        isRepository: true,
        branch: status.current,
        detached: status.detached,
        branches: branches.all,
        tracking: status.tracking,
        ahead: Number.isFinite(status.ahead) ? status.ahead : 0,
        behind: Number.isFinite(status.behind) ? status.behind : 0,
      };
    } catch {
      return empty;
    }
  });
}

/** Private GitHub repos are cloned with the stored OAuth token. */
function withCredentials(url: string, token: string | null): string {
  if (!token) return url;
  if (!/^https:\/\/github\.com\//i.test(url)) return url;
  return url.replace(/^https:\/\//i, `https://x-access-token:${token}@`);
}
