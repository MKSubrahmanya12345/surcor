import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { ActivityBar } from "../ActivityBar/ActivityBar";
import { FileTree } from "../FileTree/FileTree";
import { Editor } from "../Editor/Editor";
import { SourceControl } from "../SourceControl/SourceControl";
import { Settings } from "../Settings/Settings";
import { StatusBar } from "../StatusBar/StatusBar";
import { Terminal } from "../Terminal/Terminal";
import { ChatPanel } from "../ChatPanel/ChatPanel";
import { useUiStore } from "../../stores/useUiStore";

export function Layout() {
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const sidebarView = useUiStore((state) => state.sidebarView);
  const sidebarVisible = useUiStore((state) => state.sidebarVisible);
  const chatOpen = useUiStore((state) => state.chatOpen);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const initialX = event.clientX;
    const initialWidth = sidebarWidth;
    const move = (moveEvent: PointerEvent) => setSidebarWidth(Math.min(480, Math.max(160, initialWidth + moveEvent.clientX - initialX)));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return (
    <div className="app-shell">
      <div className="workbench">
        <ActivityBar />
        {sidebarVisible && (
          <>
            <div className="sidebar" style={{ width: sidebarWidth }}>
              {sidebarView === "source-control"
                ? <SourceControl />
                : sidebarView === "settings"
                  ? <Settings />
                  : <FileTree />}
            </div>
            <div className="pane-resizer" onPointerDown={startResize} />
          </>
        )}
        <div className="center-stack">
          <Editor />
          {/* Prompt 2 mounts the terminal panel here; the slot collapses to
              zero height while the panel is closed. */}
          <div id="panel-bottom-slot" style={{ display: "flex", flexDirection: "column" }}>
            <Terminal />
          </div>
        </div>
        {/* Prompt 4 mounts the chat panel here (style flipped from "none");
            Prompt 6 toggles it via the chatOpen UI state / Ctrl+L palette. */}
        <div id="panel-right-slot" style={{ display: chatOpen ? "flex" : "none" }}>
          <ChatPanel />
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
