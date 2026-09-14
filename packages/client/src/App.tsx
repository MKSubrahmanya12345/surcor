import { useEffect } from "react";
import { Layout } from "./components/Layout/Layout";
import { GitStatusIndicator } from "./components/GitStatusIndicator/GitStatusIndicator";
import { CommandPalette, FOCUS_CHAT_EVENT } from "./components/CommandPalette/CommandPalette";
import { useUiStore } from "./stores/useUiStore";
import { useWorkspaceStore } from "./stores/useWorkspaceStore";

export default function App() {
  const error = useWorkspaceStore((state) => state.error);
  const clearError = useWorkspaceStore((state) => state.clearError);

  // VS Code / Cursor-default keybindings (Prompt 6, Part B). They live in one
  // window-level handler so every chord behaves the same regardless of which
  // pane has focus. Existing chords: Ctrl/Cmd+Shift+E (Explorer) and
  // Ctrl/Cmd+Shift+G (Source Control); plus S-modified chords unchanged.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const ui = useUiStore.getState();
      const key = event.key.toLowerCase();

      if (event.shiftKey) {
        if (key === "e") { event.preventDefault(); ui.setSidebarView("explorer"); }
        else if (key === "g") { event.preventDefault(); ui.setSidebarView("source-control"); }
        else if (key === "p") { event.preventDefault(); ui.setPaletteMode(ui.paletteMode === "commands" ? "closed" : "commands"); }
        return;
      }

      if (key === "p") {
        event.preventDefault();
        ui.setPaletteMode(ui.paletteMode === "files" ? "closed" : "files");
      } else if (key === "b") {
        event.preventDefault();
        ui.toggleSidebar();
      } else if (key === "l") {
        event.preventDefault();
        ui.setChatOpen(true);
        window.dispatchEvent(new Event(FOCUS_CHAT_EVENT));
      } else if (event.key === "`" || key === "`") {
        event.preventDefault();
        ui.toggleBottomPanel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <Layout />
      <CommandPalette />
      <GitStatusIndicator />
      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button onClick={clearError} aria-label="Dismiss error">×</button>
        </div>
      )}
    </>
  );
}
