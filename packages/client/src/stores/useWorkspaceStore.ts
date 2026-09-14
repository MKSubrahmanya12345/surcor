import { create } from "zustand";
import type { FileNode, OpenTab } from "@forge/shared";

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
