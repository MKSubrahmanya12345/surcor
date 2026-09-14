import { useWorkspaceStore } from "../../stores/useWorkspaceStore";

export function StatusBar() {
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const tabs = useWorkspaceStore((state) => state.openTabs);
  const cursor = useWorkspaceStore((state) => state.cursorPosition);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  return (
    <footer className="status-bar">
      <div className="status-left">
        <div id="status-git-slot" />
        <span className="status-item branch-placeholder">⑂ main</span>
        <span className="status-item">ⓧ 0&nbsp;&nbsp;△ 0</span>
      </div>
      <div className="status-right">
        {activeTab && <>
          <span className="status-item">Ln {cursor.line}, Col {cursor.column}</span>
          <span className="status-item">Spaces: 2</span>
          <span className="status-item">UTF-8</span>
          <span className="status-item">{activeTab.language}</span>
        </>}
        <span className="status-item">⌁</span>
      </div>
    </footer>
  );
}
