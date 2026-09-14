import { create } from "zustand";
import type {
  GitBranchInfo,
  GitDiff,
  GitFileStatus,
  GitStatusSummary,
} from "@forge/shared";
import { useWorkspaceStore } from "./useWorkspaceStore";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const currentRepoPath = (): string | null => useWorkspaceStore.getState().folderPath;

const branchFromStatus = (status: GitStatusSummary, previous: GitBranchInfo | null): GitBranchInfo => ({
  isRepository: status.isRepository,
  branch: status.branch,
  detached: status.detached,
  branches: previous?.branches ?? [],
  tracking: status.tracking,
  ahead: status.ahead,
  behind: status.behind,
});

interface GitState {
  status: GitStatusSummary | null;
  branch: GitBranchInfo | null;
  diff: GitDiff | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;

  refresh: () => Promise<void>;
  refreshBranch: () => Promise<void>;
  openDiff: (filePath: string, staged: boolean) => Promise<void>;
  closeDiff: () => void;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  discard: (paths: string[]) => Promise<void>;
  commit: (message: string, pushAfter: boolean) => Promise<boolean>;
  push: () => Promise<void>;
  pull: () => Promise<void>;
  clearMessages: () => void;
}

/**
 * All git access goes through this store — components never call
 * `window.forge.git*` directly, so there is exactly one place that refreshes
 * the working tree after an operation.
 */
export const useGitStore = create<GitState>((set, get) => ({
  status: null,
  branch: null,
  diff: null,
  loading: false,
  busy: false,
  error: null,
  notice: null,

  refresh: async () => {
    const repoPath = currentRepoPath();
    if (!repoPath) {
      set({ status: null, branch: null, diff: null, error: null, notice: null });
      return;
    }
    set({ loading: true });
    try {
      const status = await window.forge.gitStatus({ repoPath });
      set((state) => ({
        status,
        branch: branchFromStatus(status, state.branch),
        loading: false,
        error: null,
      }));
      const { diff } = get();
      if (diff) {
        // keep an open diff in sync with the working tree
        const next = await window.forge.gitDiff({ repoPath, filePath: diff.filePath, staged: diff.staged });
        if (get().diff?.filePath === diff.filePath) set({ diff: next });
      }
    } catch (error) {
      set({ loading: false, error: errorMessage(error) });
    }
  },

  refreshBranch: async () => {
    const repoPath = currentRepoPath();
    if (!repoPath) {
      set({ branch: null });
      return;
    }
    try {
      set({ branch: await window.forge.gitBranch({ repoPath }) });
    } catch (error) {
      set({ branch: null, error: errorMessage(error) });
    }
  },

  openDiff: async (filePath, staged) => {
    const repoPath = currentRepoPath();
    if (!repoPath) return;
    set({ diff: null });
    try {
      const diff = await window.forge.gitDiff({ repoPath, filePath, staged });
      set({ diff });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  closeDiff: () => set({ diff: null }),

  stage: async (paths) => {
    const repoPath = currentRepoPath();
    if (!repoPath || paths.length === 0) return;
    set({ busy: true, error: null, notice: null });
    const result = await window.forge.gitStage({ repoPath, paths });
    set({ busy: false, error: result.ok ? null : result.message });
    await get().refresh();
  },

  unstage: async (paths) => {
    const repoPath = currentRepoPath();
    if (!repoPath || paths.length === 0) return;
    set({ busy: true, error: null, notice: null });
    const result = await window.forge.gitUnstage({ repoPath, paths });
    set({ busy: false, error: result.ok ? null : result.message });
    await get().refresh();
  },

  discard: async (paths) => {
    const repoPath = currentRepoPath();
    if (!repoPath || paths.length === 0) return;
    set({ busy: true, error: null, notice: null });
    const result = await window.forge.gitDiscard({ repoPath, paths });
    set({ busy: false, error: result.ok ? null : result.message });
    await get().refresh();
  },

  commit: async (message, pushAfter) => {
    const repoPath = currentRepoPath();
    if (!repoPath || message.trim().length === 0) return false;
    set({ busy: true, error: null, notice: null });
    const result = await window.forge.gitCommit({ repoPath, message });
    if (!result.ok) {
      set({ busy: false, error: result.message });
      return false;
    }
    let notice = result.message;
    if (pushAfter) {
      const pushed = await window.forge.gitPush({ repoPath });
      notice = pushed.ok ? `${result.message} ${pushed.message}` : result.message;
      if (!pushed.ok) {
        set({ busy: false, error: pushed.message, notice });
        await get().refresh();
        return true;
      }
    }
    set({ busy: false, notice });
    await get().refresh();
    return true;
  },

  push: async () => {
    const repoPath = currentRepoPath();
    if (!repoPath) return;
    set({ busy: true, error: null, notice: null });
    const result = await window.forge.gitPush({ repoPath });
    set({ busy: false, error: result.ok ? null : result.message, notice: result.ok ? result.message : null });
    await get().refreshBranch();
    await get().refresh();
  },

  pull: async () => {
    const repoPath = currentRepoPath();
    if (!repoPath) return;
    set({ busy: true, error: null, notice: null });
    const result = await window.forge.gitPull({ repoPath });
    set({ busy: false, error: result.ok ? null : result.message, notice: result.ok ? result.message : null });
    await get().refreshBranch();
    await get().refresh();
  },

  clearMessages: () => set({ error: null, notice: null }),
}));

export const changedFileCount = (status: GitStatusSummary | null): number =>
  status ? new Set(status.files.map((file: GitFileStatus) => file.path)).size : 0;
