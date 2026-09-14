import type { FileNode } from "@forge/shared";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";

function TreeNode({ node, depth }: { node: FileNode; depth: number }) {
  const toggleDirectory = useWorkspaceStore((state) => state.toggleDirectory);
  const openFile = useWorkspaceStore((state) => state.openFile);
  const isExpanded = node.children !== undefined;

  return (
    <>
      <button
        className={`tree-row ${node.isDirectory ? "directory" : "file"}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={node.path}
        onClick={() => node.isDirectory ? void toggleDirectory(node.path) : void openFile(node.path)}
      >
        <span className="tree-chevron">{node.isDirectory ? (isExpanded ? "⌄" : "›") : ""}</span>
        <span className="tree-icon" aria-hidden="true">{node.isDirectory ? (isExpanded ? "▾" : "▸") : "◇"}</span>
        <span className="tree-name">{node.name}</span>
      </button>
      {node.children?.map((child) => <TreeNode key={child.path} node={child} depth={depth + 1} />)}
    </>
  );
}

export function FileTree() {
  const folderPath = useWorkspaceStore((state) => state.folderPath);
  const fileTree = useWorkspaceStore((state) => state.fileTree);
  const openFolder = useWorkspaceStore((state) => state.openFolder);
  const folderName = folderPath?.split(/[\\/]/).filter(Boolean).pop();

  return (
    <aside className="explorer-panel">
      <div className="panel-title">EXPLORER</div>
      {!folderPath ? (
        <div className="explorer-empty">
          <p>You have not yet opened a folder.</p>
          <button className="primary-button" onClick={() => void openFolder()}>Open Folder</button>
        </div>
      ) : (
        <div className="tree" role="tree">
          <div className="workspace-heading"><span>⌄</span>{folderName}</div>
          {fileTree.map((node) => <TreeNode key={node.path} node={node} depth={0} />)}
        </div>
      )}
    </aside>
  );
}
