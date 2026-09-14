import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { changedFileCount, useGitStore } from "../../stores/useGitStore";
import { useUiStore } from "../../stores/useUiStore";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";

/**
 * Fills Prompt 1's named `#status-git-slot` via a portal, so StatusBar.tsx
 * never has to change. When there is no repository it renders nothing and the
 * slot stays empty (the placeholder branch label reappears via CSS).
 */
export function GitStatusIndicator() {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const folderPath = useWorkspaceStore((state) => state.folderPath);
  const branch = useGitStore((state) => state.branch);
  const status = useGitStore((state) => state.status);
  const refreshBranch = useGitStore((state) => state.refreshBranch);
  const setSidebarView = useUiStore((state) => state.setSidebarView);

  useEffect(() => {
    setSlot(document.getElementById("status-git-slot"));
  }, []);

  useEffect(() => {
    void refreshBranch();
  }, [folderPath, refreshBranch]);

  if (!slot || !branch?.isRepository || !branch.branch) return null;

  const changes = changedFileCount(status);
  const sync = `${branch.behind > 0 ? `↓${branch.behind}` : ""}${branch.ahead > 0 ? ` ↑${branch.ahead}` : ""}`.trim();

  return createPortal(
    <>
      <button
        className="status-item status-git"
        title={`${branch.branch}${branch.tracking ? ` ↔ ${branch.tracking}` : ""}`}
        onClick={() => setSidebarView("source-control")}
      >
        <span>⑂ {branch.branch}</span>
      </button>
      {sync && <span className="status-item" title={`Not synced with ${branch.tracking ?? "origin"}`}>{sync}</span>}
      {changes > 0 && (
        <span className="status-item" title={`${changes} changed file(s)`} onClick={() => setSidebarView("source-control")}>
          ⓧ {changes}
        </span>
      )}
    </>,
    slot,
  );
}
