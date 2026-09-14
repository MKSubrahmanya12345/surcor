import { create } from "zustand";

export type SidebarView = "explorer" | "source-control" | "settings";

/** What the command palette overlay is showing; "closed" = unmounted. */
export type PaletteMode = "closed" | "commands" | "files";

const MIN_PANEL_HEIGHT = 96;
const MAX_PANEL_HEIGHT = 720;

interface UiState {
  sidebarView: SidebarView;
  sidebarVisible: boolean;
  bottomPanelOpen: boolean;
  bottomPanelHeight: number;
  chatOpen: boolean;
  paletteMode: PaletteMode;
  setSidebarView: (view: SidebarView) => void;
  toggleSidebar: () => void;
  setBottomPanelOpen: (open: boolean) => void;
  toggleBottomPanel: () => void;
  setBottomPanelHeight: (height: number) => void;
  toggleChat: () => void;
  setChatOpen: (open: boolean) => void;
  setPaletteMode: (mode: PaletteMode) => void;
}

/**
 * Purely presentational shell state (which sidebar panel is showing, whether
 * the terminal/chat panels are open, the command palette). Kept separate from
 * workspace state so neither store grows a second responsibility.
 */
export const useUiStore = create<UiState>((set) => ({
  sidebarView: "explorer",
  sidebarVisible: true,
  bottomPanelOpen: true,
  bottomPanelHeight: 240,
  chatOpen: true,
  paletteMode: "closed",

  setSidebarView: (sidebarView) => set({ sidebarView, sidebarVisible: true }),
  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),
  setBottomPanelOpen: (bottomPanelOpen) => set({ bottomPanelOpen }),
  toggleBottomPanel: () => set((state) => ({ bottomPanelOpen: !state.bottomPanelOpen })),
  setBottomPanelHeight: (height) =>
    set({ bottomPanelHeight: Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, Math.round(height))) }),
  toggleChat: () => set((state) => ({ chatOpen: !state.chatOpen })),
  setChatOpen: (chatOpen) => set({ chatOpen }),
  setPaletteMode: (paletteMode) => set({ paletteMode }),
}));
