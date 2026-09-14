import { create } from "zustand";
import type { DeviceAuthState, GitHubAuthStatus, GitHubRepo, GitHubSession } from "@forge/shared";
import { useWorkspaceStore } from "./useWorkspaceStore";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface GitHubState {
  authStatus: GitHubAuthStatus | null;
  deviceAuth: DeviceAuthState | null;
  session: GitHubSession | null;
  repos: GitHubRepo[];
  loading: boolean;      // status / repo list in flight
  connecting: boolean;   // device flow in flight
  cloningRepo: string | null;
  error: string | null;

  loadStatus: () => Promise<void>;
  startAuth: (clientId?: string) => Promise<void>;
  pollAuth: () => Promise<void>;
  cancelAuth: () => void;
  signOut: () => Promise<void>;
  loadRepos: () => Promise<void>;
  clone: (repo: GitHubRepo) => Promise<void>;
  clearError: () => void;
}

/**
 * GitHub device-flow auth + repository list + clone.
 * Cloning deliberately reuses `useWorkspaceStore.openFolder`, which is the
 * one and only folder-opening code path in the app.
 */
export const useGitHubStore = create<GitHubState>((set, get) => ({
  authStatus: null,
  deviceAuth: null,
  session: null,
  repos: [],
  loading: false,
  connecting: false,
  cloningRepo: null,
  error: null,

  loadStatus: async () => {
    set({ loading: true, error: null });
    try {
      const authStatus = await window.forge.githubStatus();
      set({
        authStatus,
        session: authStatus.session,
        loading: false,
        repos: authStatus.connected ? get().repos : [],
      });
    } catch (error) {
      set({ loading: false, error: errorMessage(error) });
    }
  },

  startAuth: async (clientId) => {
    set({ connecting: true, error: null, deviceAuth: null });
    const state = await window.forge.githubStartAuth(clientId ? { clientId } : {});
    set({ deviceAuth: state, connecting: state.status === "polling", error: state.error ?? null });
  },

  pollAuth: async () => {
    const state = await window.forge.githubPollAuth();
    set({ deviceAuth: state });
    if (state.status === "success") {
      set({ connecting: false, deviceAuth: null });
      await get().loadStatus();
      await get().loadRepos();
      return;
    }
    if (state.status === "error") {
      set({ connecting: false, error: state.error ?? "GitHub authorization failed." });
      return;
    }
    if (state.status === "idle") {
      set({ connecting: false });
    }
  },

  cancelAuth: () => set({ deviceAuth: null, connecting: false, error: null }),

  signOut: async () => {
    await window.forge.githubSignOut();
    set({ authStatus: null, session: null, repos: [], deviceAuth: null, connecting: false });
    await get().loadStatus();
  },

  loadRepos: async () => {
    set({ loading: true, error: null });
    try {
      const result = await window.forge.githubListRepos();
      set({ repos: result.repos, loading: false, error: result.ok ? null : result.message });
    } catch (error) {
      set({ loading: false, error: errorMessage(error) });
    }
  },

  clone: async (repo) => {
    set({ cloningRepo: repo.fullName, error: null });
    try {
      const parentDir = await window.forge.openFolder();
      if (!parentDir) {
        set({ cloningRepo: null });
        return;
      }
      const result = await window.forge.gitClone({ url: repo.cloneUrl, parentDir, directory: repo.name });
      if (!result.ok) {
        set({ cloningRepo: null, error: result.message });
        return;
      }
      set({ cloningRepo: null });
      await useWorkspaceStore.getState().openFolder(result.repoPath);
    } catch (error) {
      set({ cloningRepo: null, error: errorMessage(error) });
    }
  },

  clearError: () => set({ error: null }),
}));
