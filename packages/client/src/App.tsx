import { useEffect } from "react";
import { Layout } from "./components/Layout/Layout";
import { GitStatusIndicator } from "./components/GitStatusIndicator/GitStatusIndicator";
import { useUiStore } from "./stores/useUiStore";
import { useWorkspaceStore } from "./stores/useWorkspaceStore";

export default function App() {
  const error = useWorkspaceStore((state) => state.error);
  const clearError = useWorkspaceStore((state) => state.clearError);
  const setSidebarView = useUiStore((state) => state.setSidebarView);

  // VS Code-flavoured view shortcuts: Ctrl/Cmd+Shift+E / G
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "e") {
        event.preventDefault();
        setSidebarView("explorer");
      } else if (key === "g") {
        event.preventDefault();
        setSidebarView("source-control");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setSidebarView]);

  return (
    <>
      <Layout />
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
