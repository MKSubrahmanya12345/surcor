import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type DeviceAuthState,
  type FileNode,
  type GitBranchInfo,
  type GitCloneResult,
  type GitDiff,
  type GitHubAuthStatus,
  type GitHubRepo,
  type GitOperationResult,
  type GitStatusSummary,
  type McpServerConfig,
  type TerminalSessionInfo,
} from "@forge/shared";

interface TerminalDataPayload {
  id: string;
  data: string;
}

interface TerminalExitPayload {
  id: string;
  exitCode: number;
  signal?: number;
}

export interface ForgeAPI {
  // --- Workspace / file system (Prompt 1) ---
  openFolder: () => Promise<string | null>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  listDir: (path: string) => Promise<FileNode[]>;
  createFile: (path: string, isDirectory?: boolean) => Promise<void>;
  deleteFile: (path: string) => Promise<void>;
  rename: (oldPath: string, newPath: string) => Promise<void>;

  // --- Terminal (Prompt 2) ---
  terminalCreate: (options?: {
    cwd?: string;
    shell?: string;
    cols?: number;
    rows?: number;
  }) => Promise<TerminalSessionInfo>;
  terminalWrite: (options: { id: string; data: string }) => Promise<void>;
  terminalResize: (options: { id: string; cols: number; rows: number }) => Promise<void>;
  terminalKill: (options: { id: string }) => Promise<void>;
  onTerminalData: (listener: (payload: TerminalDataPayload) => void) => () => void;
  onTerminalExit: (listener: (payload: TerminalExitPayload) => void) => () => void;

  // --- Git (Prompt 2) ---
  gitStatus: (options: { repoPath: string }) => Promise<GitStatusSummary>;
  gitDiff: (options: { repoPath: string; filePath: string; staged?: boolean }) => Promise<GitDiff>;
  gitStage: (options: { repoPath: string; paths: string[] }) => Promise<GitOperationResult>;
  gitUnstage: (options: { repoPath: string; paths: string[] }) => Promise<GitOperationResult>;
  gitDiscard: (options: { repoPath: string; paths: string[] }) => Promise<GitOperationResult>;
  gitCommit: (options: { repoPath: string; message: string; stageAll?: boolean }) => Promise<GitOperationResult>;
  gitPush: (options: { repoPath: string; remote?: string; branch?: string }) => Promise<GitOperationResult>;
  gitPull: (options: { repoPath: string; remote?: string; branch?: string }) => Promise<GitOperationResult>;
  gitClone: (options: { url: string; parentDir: string; directory?: string }) => Promise<GitCloneResult>;
  gitBranch: (options: { repoPath: string }) => Promise<GitBranchInfo>;

  // --- GitHub (Prompt 2) ---
  githubStatus: () => Promise<GitHubAuthStatus>;
  githubStartAuth: (options?: { clientId?: string }) => Promise<DeviceAuthState>;
  githubPollAuth: () => Promise<DeviceAuthState>;
  githubListRepos: () => Promise<{ ok: boolean; repos: GitHubRepo[]; message: string }>;
  githubSignOut: () => Promise<{ ok: boolean }>;

  // --- MCP settings (Prompt 6): manage ~/.forge/mcp.json ---
  mcpListServers: () => Promise<McpServerConfig[]>;
  mcpAddServer: (options: { name: string; command: string; args?: string[]; env?: Record<string, string> }) => Promise<McpServerConfig[]>;
  mcpRemoveServer: (options: { name: string }) => Promise<McpServerConfig[]>;
}

/** Subscribes to a main-process push channel and returns an unsubscribe fn. */
const on = <T>(channel: string, listener: (payload: T) => void): (() => void) => {
  const wrapped = (_event: unknown, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

const api: ForgeAPI = {
  openFolder: () => ipcRenderer.invoke(IPC.FS_OPEN_FOLDER),
  readFile: (path) => ipcRenderer.invoke(IPC.FS_READ_FILE, { path }),
  writeFile: (path, content) => ipcRenderer.invoke(IPC.FS_WRITE_FILE, { path, content }),
  listDir: (path) => ipcRenderer.invoke(IPC.FS_LIST_DIR, { path }),
  createFile: (path, isDirectory) => ipcRenderer.invoke(IPC.FS_CREATE_FILE, { path, isDirectory }),
  deleteFile: (path) => ipcRenderer.invoke(IPC.FS_DELETE_FILE, { path }),
  rename: (oldPath, newPath) => ipcRenderer.invoke(IPC.FS_RENAME, { oldPath, newPath }),

  terminalCreate: (options = {}) => ipcRenderer.invoke(IPC.TERMINAL_CREATE, options),
  terminalWrite: (options) => ipcRenderer.invoke(IPC.TERMINAL_WRITE, options),
  terminalResize: (options) => ipcRenderer.invoke(IPC.TERMINAL_RESIZE, options),
  terminalKill: (options) => ipcRenderer.invoke(IPC.TERMINAL_KILL, options),
  onTerminalData: (listener) => on<TerminalDataPayload>(IPC.TERMINAL_DATA, listener),
  onTerminalExit: (listener) => on<TerminalExitPayload>(IPC.TERMINAL_EXIT, listener),

  gitStatus: (options) => ipcRenderer.invoke(IPC.GIT_STATUS, options),
  gitDiff: (options) => ipcRenderer.invoke(IPC.GIT_DIFF, options),
  gitStage: (options) => ipcRenderer.invoke(IPC.GIT_STAGE, options),
  gitUnstage: (options) => ipcRenderer.invoke(IPC.GIT_UNSTAGE, options),
  gitDiscard: (options) => ipcRenderer.invoke(IPC.GIT_DISCARD, options),
  gitCommit: (options) => ipcRenderer.invoke(IPC.GIT_COMMIT, options),
  gitPush: (options) => ipcRenderer.invoke(IPC.GIT_PUSH, options),
  gitPull: (options) => ipcRenderer.invoke(IPC.GIT_PULL, options),
  gitClone: (options) => ipcRenderer.invoke(IPC.GIT_CLONE, options),
  gitBranch: (options) => ipcRenderer.invoke(IPC.GIT_BRANCH, options),

  githubStatus: () => ipcRenderer.invoke(IPC.GITHUB_STATUS),
  githubStartAuth: (options = {}) => ipcRenderer.invoke(IPC.GITHUB_START_AUTH, options),
  githubPollAuth: () => ipcRenderer.invoke(IPC.GITHUB_POLL_AUTH),
  githubListRepos: () => ipcRenderer.invoke(IPC.GITHUB_LIST_REPOS),
  githubSignOut: () => ipcRenderer.invoke(IPC.GITHUB_SIGN_OUT),

  mcpListServers: () => ipcRenderer.invoke(IPC.MCP_LIST_SERVERS),
  mcpAddServer: (options) => ipcRenderer.invoke(IPC.MCP_ADD_SERVER, options),
  mcpRemoveServer: (options) => ipcRenderer.invoke(IPC.MCP_REMOVE_SERVER, options),
};

contextBridge.exposeInMainWorld("forge", api);
