import { create } from "zustand";
import type { FileNode, OpenTab } from "@forge/shared";
import {
  clearChildren, dirName, findNode, isInside, joinPath, nearestKnownAncestor,
  remapSubtree, replacePrefix, separatorFor, validateEntryName,
} from "../components/FileTree/treeOps";

interface WorkspaceState {
  folderPath: string | null;
  fileTree: FileNode[];
  openTabs: OpenTab[];
  activeTabId: string | null;
  contents: Record<string, string>;
  cursorPosition: { line: number; column: number };
  error: string | null;
  openFolder: (folderPath?: string) => Promise<void>;
  toggleDirectory: (directoryPath: string) => Promise<void>;
  openFile: (filePath: string) => Promise<void>;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateContent: (tabId: string, content: string) => void;
  /**
   * Replace the buffer of every open tab whose file changed outside the
   * editor (agent diff accepted, checkpoint restore). Content now matches
   * disk, so the dirty flag is cleared. (Prompt 4)
   */
  applyExternalFileContent: (filePath: string, content: string) => void;
  /**
   * Explorer file operations. They go through the same main-process IPC
   * handlers Prompt 1 registered (`fs:createFile`, `fs:rename`, `fs:deleteFile`)
   * — there is still exactly one way to touch the disk — and then refresh the
   * smallest subtree that can show the result.
   */
  refreshFrom: (directoryPath: string | null) => Promise<void>;
  refreshTree: () => Promise<void>;
  revealPath: (targetPath: string) => Promise<void>;
  createEntry: (parentPath: string | null, name: string, isDirectory: boolean) => Promise<string | null>;
  renameEntry: (targetPath: string, newName: string) => Promise<string | null>;
  deleteEntry: (targetPath: string) => Promise<boolean>;
  collapseAll: () => void;
  saveActiveFile: () => Promise<void>;
  setCursorPosition: (line: number, column: number) => void;
  clearError: () => void;
}

const languageForPath = (filePath: string): string => {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  const languages: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", css: "css", scss: "scss", html: "html", md: "markdown",
    py: "python", rs: "rust", go: "go", java: "java", c: "c", cpp: "cpp",
    h: "c", hpp: "cpp", sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml",
    xml: "xml", sql: "sql", toml: "ini",
  };
  return languages[extension] ?? "plaintext";
};

const replaceNode = (nodes: FileNode[], targetPath: string, update: (node: FileNode) => FileNode): FileNode[] =>
  nodes.map((node) => {
    if (node.path === targetPath) return update(node);
    if (node.children) return { ...node, children: replaceNode(node.children, targetPath, update) };
    return node;
  });

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Re-list a directory and every one of its directories that is currently
 * expanded, so "Refresh" updates the whole visible tree without collapsing it.
 */
async function refreshSubtree(directoryPath: string, previous: FileNode[] | undefined): Promise<FileNode[]> {
  const children = await window.forge.listDir(directoryPath);
  const before = new Map((previous ?? []).map((node) => [node.path, node]));
  const result: FileNode[] = [];
  for (const child of children) {
    const old = before.get(child.path);
    result.push(child.isDirectory && old?.children
      ? { ...child, children: await refreshSubtree(child.path, old.children) }
      : child);
  }
  return result;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  folderPath: null,
  fileTree: [],
  openTabs: [],
  activeTabId: null,
  contents: {},
  cursorPosition: { line: 1, column: 1 },
  error: null,

  openFolder: async (providedPath) => {
    try {
      const folderPath = providedPath ?? await window.forge.openFolder();
      if (!folderPath) return;
      const fileTree = await window.forge.listDir(folderPath);
      set({ folderPath, fileTree, openTabs: [], activeTabId: null, contents: {}, error: null });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  toggleDirectory: async (directoryPath) => {
    const nodeIsExpanded = (nodes: FileNode[]): boolean => {
      for (const node of nodes) {
        if (node.path === directoryPath) return node.children !== undefined;
        if (node.children && nodeIsExpanded(node.children)) return true;
      }
      return false;
    };
    try {
      if (nodeIsExpanded(get().fileTree)) {
        set((state) => ({ fileTree: replaceNode(state.fileTree, directoryPath, (node) => ({ ...node, children: undefined })) }));
      } else {
        const children = await window.forge.listDir(directoryPath);
        set((state) => ({ fileTree: replaceNode(state.fileTree, directoryPath, (node) => ({ ...node, children })) }));
      }
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  openFile: async (filePath) => {
    const existing = get().openTabs.find((tab) => tab.filePath === filePath);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    try {
      const content = await window.forge.readFile(filePath);
      const id = crypto.randomUUID();
      const tab: OpenTab = { id, filePath, isDirty: false, language: languageForPath(filePath) };
      set((state) => ({
        openTabs: [...state.openTabs, tab],
        activeTabId: id,
        contents: { ...state.contents, [id]: content },
        error: null,
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  closeTab: (tabId) => set((state) => {
    const index = state.openTabs.findIndex((tab) => tab.id === tabId);
    const openTabs = state.openTabs.filter((tab) => tab.id !== tabId);
    const contents = { ...state.contents };
    delete contents[tabId];
    let activeTabId = state.activeTabId;
    if (activeTabId === tabId) activeTabId = openTabs[Math.min(index, openTabs.length - 1)]?.id ?? null;
    return { openTabs, contents, activeTabId };
  }),

  setActiveTab: (activeTabId) => set({ activeTabId }),

  updateContent: (tabId, content) => set((state) => ({
    contents: { ...state.contents, [tabId]: content },
    openTabs: state.openTabs.map((tab) => tab.id === tabId ? { ...tab, isDirty: true } : tab),
  })),

  applyExternalFileContent: (filePath, content) => set((state) => {
    if (!state.openTabs.some((tab) => tab.filePath === filePath)) return {};
    const contents = { ...state.contents };
    for (const tab of state.openTabs) {
      if (tab.filePath === filePath) contents[tab.id] = content;
    }
    return {
      contents,
      openTabs: state.openTabs.map((tab) =>
        tab.filePath === filePath ? { ...tab, isDirty: false } : tab),
    };
  }),

  refreshFrom: async (directoryPath) => {
    const { folderPath, fileTree } = get();
    if (!folderPath) return;
    const target = directoryPath ?? folderPath;
    try {
      const previous = directoryPath ? findNode(fileTree, directoryPath)?.children : fileTree;
      const children = await refreshSubtree(target, previous);
      set((state) => ({
        fileTree: directoryPath
          ? replaceNode(state.fileTree, directoryPath, (node) => ({ ...node, children }))
          : children,
        error: null,
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  refreshTree: async () => { await get().refreshFrom(null); },

  collapseAll: () => set((state) => ({ fileTree: clearChildren(state.fileTree) })),

  revealPath: async (targetPath) => {
    const { folderPath, fileTree } = get();
    if (!folderPath || !isInside(folderPath, targetPath)) return;
    const sep = separatorFor(folderPath);
    // Chain of directories from the workspace root down to the entry's parent.
    const chain: string[] = [];
    let cursor = dirName(targetPath, sep);
    while (cursor && cursor !== folderPath && isInside(folderPath, cursor, sep)) {
      chain.unshift(cursor);
      cursor = dirName(cursor, sep);
    }
    const known = nearestKnownAncestor(fileTree, targetPath, sep);
    try {
      await get().refreshFrom(known);
      // Expand downwards one level at a time; each refresh puts the next
      // directory into the tree, so the following one can find it.
      for (const directory of chain) {
        if (directory === known) continue;
        await get().refreshFrom(directory);
      }
    } catch { /* refreshFrom already reported the failure */ }
  },

  createEntry: async (parentPath, name, isDirectory) => {
    const { folderPath } = get();
    if (!folderPath) return null;
    const trimmed = name.trim();
    const problem = validateEntryName(trimmed);
    if (problem) { set({ error: problem }); return null; }
    const parent = parentPath ?? folderPath;
    const target = joinPath(parent, trimmed);
    try {
      await window.forge.createFile(target, isDirectory);
      await get().revealPath(target);
      set({ error: null });
      if (!isDirectory) await get().openFile(target);
      return target;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  renameEntry: async (targetPath, newName) => {
    const { folderPath } = get();
    if (!folderPath) return null;
    const trimmed = newName.trim();
    const problem = validateEntryName(trimmed);
    if (problem) { set({ error: problem }); return null; }
    const sep = separatorFor(targetPath);
    const parent = dirName(targetPath, sep);
    const nextPath = joinPath(parent, trimmed, sep);
    if (nextPath === targetPath) return null;
    try {
      await window.forge.rename(targetPath, nextPath);
      // Rewrite the renamed subtree first so an expanded folder stays expanded,
      // then re-list its parent to pick up the new name and sort position.
      set((state) => ({
        fileTree: remapSubtree(state.fileTree, targetPath, nextPath, sep),
        openTabs: state.openTabs.map((tab) => {
          const moved = replacePrefix(tab.filePath, targetPath, nextPath, sep);
          return moved ? { ...tab, filePath: moved, language: languageForPath(moved) } : tab;
        }),
        error: null,
      }));
      await get().refreshFrom(parent === folderPath ? null : parent);
      return nextPath;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  deleteEntry: async (targetPath) => {
    const { folderPath } = get();
    if (!folderPath) return false;
    const sep = separatorFor(targetPath);
    try {
      await window.forge.deleteFile(targetPath);
      set((state) => {
        const kept = state.openTabs.filter((tab) => !isInside(targetPath, tab.filePath, sep));
        const closed = state.openTabs.filter((tab) => isInside(targetPath, tab.filePath, sep));
        const contents = { ...state.contents };
        for (const tab of closed) delete contents[tab.id];
        const activeTabId = kept.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : kept.at(-1)?.id ?? null;
        return { openTabs: kept, contents, activeTabId, error: null };
      });
      const ancestor = nearestKnownAncestor(get().fileTree, targetPath, sep);
      await get().refreshFrom(ancestor);
      return true;
    } catch (error) {
      set({ error: errorMessage(error) });
      return false;
    }
  },

  saveActiveFile: async () => {
    const { activeTabId, openTabs, contents } = get();
    const tab = openTabs.find((item) => item.id === activeTabId);
    if (!tab || !tab.isDirty) return;
    try {
      await window.forge.writeFile(tab.filePath, contents[tab.id] ?? "");
      set((state) => ({
        openTabs: state.openTabs.map((item) => item.id === tab.id ? { ...item, isDirty: false } : item),
        error: null,
      }));
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  setCursorPosition: (line, column) => set({ cursorPosition: { line, column } }),
  clearError: () => set({ error: null }),
}));
