import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { ActivityBar } from "../ActivityBar/ActivityBar";
import { FileTree } from "../FileTree/FileTree";
import { Editor } from "../Editor/Editor";
import { StatusBar } from "../StatusBar/StatusBar";

export function Layout() {
  const [sidebarWidth, setSidebarWidth] = useState(240);

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
        <div className="sidebar" style={{ width: sidebarWidth }}><FileTree /></div>
        <div className="pane-resizer" onPointerDown={startResize} />
        <div className="center-stack">
          <Editor />
          <div id="panel-bottom-slot" style={{ display: "none" }} />
        </div>
        <div id="panel-right-slot" style={{ display: "none" }} />
      </div>
      <StatusBar />
    </div>
  );
}
