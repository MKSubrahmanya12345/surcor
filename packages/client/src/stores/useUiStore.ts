import { create } from "zustand";

export type SidebarView = "explorer" | "source-control";

const MIN_PANEL_HEIGHT = 96;
const MAX_PANEL_HEIGHT = 720;

interface UiState {
  sidebarView: SidebarView;
  bottomPanelOpen: boolean;
  bottomPanelHeight: number;
  setSidebarView: (view: SidebarView) => void;
  setBottomPanelOpen: (open: boolean) => void;
  toggleBottomPanel: () => void;
  setBottomPanelHeight: (height: number) => void;
}

/**
 * Purely presentational shell state (which sidebar panel is showing, whether
 * the bottom terminal panel is open). Kept separate from workspace state so
 * neither store grows a second responsibility.
 */
export const useUiStore = create<UiState>((set) => ({
  sidebarView: "explorer",
  bottomPanelOpen: true,
  bottomPanelHeight: 240,

  setSidebarView: (sidebarView) => set({ sidebarView }),
  setBottomPanelOpen: (bottomPanelOpen) => set({ bottomPanelOpen }),
  toggleBottomPanel: () => set((state) => ({ bottomPanelOpen: !state.bottomPanelOpen })),
  setBottomPanelHeight: (height) =>
    set({ bottomPanelHeight: Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, Math.round(height))) }),
}));
