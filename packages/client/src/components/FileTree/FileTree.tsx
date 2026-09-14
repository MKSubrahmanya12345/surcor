import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { FileNode } from "@forge/shared";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { TreeContextMenu, type MenuPosition, type TreeMenuItem } from "./TreeContextMenu";
import { dirName, findNode, isInside, separatorFor } from "./treeOps";

/**
 * Explorer tree.
 *
 * Prompt 1 rendered it read-only; the main process already had `fs:createFile`,
 * `fs:rename` and `fs:deleteFile` handlers waiting for a UI. This adds that UI:
 * a toolbar, a right-click context menu, an inline name input, selection, and
 * F2/Delete — all going through the existing IPC handlers and the existing
 * `useWorkspaceStore` actions, so there is still exactly one way to touch disk.
 */

type InlineEdit =
  | { kind: "create"; isDirectory: boolean; parentPath: string | null; depth: number }
  | { kind: "rename"; targetPath: string; depth: number; initialValue: string; isDirectory: boolean };

type IconName = "new-file" | "new-folder" | "refresh" | "collapse";

function TreeIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    "new-file": <><path d="M13 3H6v18h12V8z" /><path d="M13 3v5h5" /><path d="M12 11.5v5M9.5 14h5" /></>,
    "new-folder": <><path d="M3 6h6l2 2h10v11H3z" /><path d="M12 11v6M9 14h6" /></>,
    refresh: <><path d="M20 12a8 8 0 1 1-2.6-5.9" /><path d="M20 3.5V9h-5.5" /></>,
    collapse: <><path d="M7 9.5 12 5l5 4.5M7 14.5 12 19l5-4.5" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

interface TreeUi {
  selectedPath: string | null;
  inline: InlineEdit | null;
  onRowClick: (node: FileNode) => void;
  onRowMenu: (event: ReactMouseEvent, node: FileNode) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

function InlineInput({ depth, initialValue, isDirectory, ariaLabel, onCommit, onCancel }: {
  depth: number;
  initialValue: string;
  isDirectory: boolean;
  ariaLabel: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    // Renaming a file selects the name without its extension, like VS Code.
    const dot = initialValue.lastIndexOf(".");
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  }, [initialValue]);

  const commit = (): void => {
    const next = value.trim();
    if (!next || next === initialValue) onCancel();
    else onCommit(next);
  };

  return (
    <div className="tree-row editing" style={{ paddingLeft: 8 + depth * 14 }}>
      <span className="tree-icon" aria-hidden="true">{isDirectory ? "▸" : "◇"}</span>
      <input
        ref={ref}
        className="tree-input"
        value={value}
        aria-label={ariaLabel}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setValue(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // Keep global shortcuts (Ctrl+S, Ctrl+Shift+E, …) away from the input.
          event.stopPropagation();
          if (event.key === "Enter") { event.preventDefault(); commit(); }
          else if (event.key === "Escape") { event.preventDefault(); onCancel(); }
        }}
        onBlur={onCancel}
      />
    </div>
  );
}

function TreeNode({ node, depth, ui }: { node: FileNode; depth: number; ui: TreeUi }) {
  const isExpanded = node.children !== undefined;
  const inline = ui.inline;

  return (
    <>
      {inline?.kind === "rename" && inline.targetPath === node.path ? (
        <InlineInput
          depth={depth}
          initialValue={node.name}
          isDirectory={node.isDirectory}
          ariaLabel={`Rename ${node.name}`}
          onCommit={ui.onCommit}
          onCancel={ui.onCancel}
        />
      ) : (
        <button
          className={`tree-row ${node.isDirectory ? "directory" : "file"} ${ui.selectedPath === node.path ? "selected" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={node.path}
          role="treeitem"
          aria-selected={ui.selectedPath === node.path}
          aria-expanded={node.isDirectory ? isExpanded : undefined}
          onClick={() => ui.onRowClick(node)}
          onContextMenu={(event) => ui.onRowMenu(event, node)}
        >
          <span className="tree-chevron">{node.isDirectory ? (isExpanded ? "⌄" : "›") : ""}</span>
          <span className="tree-icon" aria-hidden="true">{node.isDirectory ? (isExpanded ? "▾" : "▸") : "◇"}</span>
          <span className="tree-name">{node.name}</span>
        </button>
      )}

      {inline?.kind === "create" && inline.parentPath === node.path && isExpanded && (
        <InlineInput
          depth={depth + 1}
          initialValue=""
          isDirectory={inline.isDirectory}
          ariaLabel={inline.isDirectory ? "New folder name" : "New file name"}
          onCommit={ui.onCommit}
          onCancel={ui.onCancel}
        />
      )}

      {node.children?.map((child) => <TreeNode key={child.path} node={child} depth={depth + 1} ui={ui} />)}
    </>
  );
}

export function FileTree() {
  const folderPath = useWorkspaceStore((state) => state.folderPath);
  const fileTree = useWorkspaceStore((state) => state.fileTree);
  const openFolder = useWorkspaceStore((state) => state.openFolder);
  const toggleDirectory = useWorkspaceStore((state) => state.toggleDirectory);
  const openFile = useWorkspaceStore((state) => state.openFile);
  const createEntry = useWorkspaceStore((state) => state.createEntry);
  const renameEntry = useWorkspaceStore((state) => state.renameEntry);
  const deleteEntry = useWorkspaceStore((state) => state.deleteEntry);
  const refreshTree = useWorkspaceStore((state) => state.refreshTree);
  const collapseAll = useWorkspaceStore((state) => state.collapseAll);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [inline, setInline] = useState<InlineEdit | null>(null);
  const [menu, setMenu] = useState<{ position: MenuPosition; node: FileNode | null } | null>(null);

  // A different workspace means different paths: drop selection/menu/input.
  useEffect(() => {
    setSelectedPath(null);
    setInline(null);
    setMenu(null);
  }, [folderPath]);

  const folderName = folderPath?.split(/[\\/]/).filter(Boolean).pop();
  const separator = folderPath ? separatorFor(folderPath) : "/";

  const relativeTo = (path: string): string => {
    if (!folderPath) return path;
    const prefix = folderPath.endsWith(separator) ? folderPath : `${folderPath}${separator}`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  };
  const depthOf = (path: string): number => Math.max(0, relativeTo(path).split(separator).length - 1);

  /** Folder a toolbar "New File"/"New Folder" acts on: the selection's folder. */
  const creationTarget = (path: string | null): { parentPath: string | null; depth: number } => {
    if (!path || !folderPath) return { parentPath: null, depth: 0 };
    const node = findNode(fileTree, path);
    if (node?.isDirectory) return { parentPath: path, depth: depthOf(path) + 1 };
    const parent = dirName(path, separator);
    if (parent === folderPath || !isInside(folderPath, parent, separator)) return { parentPath: null, depth: 0 };
    return { parentPath: parent, depth: depthOf(parent) + 1 };
  };

  const startCreate = async (isDirectory: boolean, parentPath: string | null, depth: number): Promise<void> => {
    setMenu(null);
    let parent = parentPath;
    let inputDepth = depth;
    if (parent) {
      const node = findNode(fileTree, parent);
      // A stale selection (the folder was deleted or renamed elsewhere) would
      // leave the input with nowhere to render: fall back to the workspace root.
      if (!node) { parent = null; inputDepth = 0; }
      // The input renders inside the folder, so it has to be expanded first.
      else if (node.children === undefined) await toggleDirectory(parent);
    }
    setInline({ kind: "create", isDirectory, parentPath: parent, depth: inputDepth });
  };

  const startRename = (node: FileNode): void => {
    setMenu(null);
    setInline({
      kind: "rename", targetPath: node.path, depth: depthOf(node.path),
      initialValue: node.name, isDirectory: node.isDirectory,
    });
  };

  const commitInline = async (value: string): Promise<void> => {
    const edit = inline;
    setInline(null);
    if (!edit) return;
    if (edit.kind === "create") {
      const created = await createEntry(edit.parentPath, value, edit.isDirectory);
      if (created) setSelectedPath(created);
      return;
    }
    const renamed = await renameEntry(edit.targetPath, value);
    if (renamed) setSelectedPath(renamed);
  };

  const cancelInline = (): void => setInline(null);

  const confirmDelete = async (node: FileNode): Promise<void> => {
    setMenu(null);
    const question = node.isDirectory
      ? `Delete the folder "${node.name}" and everything inside it? This cannot be undone.`
      : `Delete "${node.name}"? This cannot be undone.`;
    if (!window.confirm(question)) return;
    const deleted = await deleteEntry(node.path);
    if (deleted && selectedPath && isInside(node.path, selectedPath, separator)) setSelectedPath(null);
  };

  const copyPath = async (node: FileNode, relative: boolean): Promise<void> => {
    setMenu(null);
    const value = relative ? relativeTo(node.path) : node.path;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(value); return; } catch { /* fall through to the legacy path */ }
    }
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); } catch { /* clipboard unavailable */ }
    area.remove();
  };

  const openMenu = (event: ReactMouseEvent, node: FileNode | null): void => {
    event.preventDefault();
    event.stopPropagation();
    if (node) setSelectedPath(node.path);
    setMenu({ position: { x: event.clientX, y: event.clientY }, node });
  };

  const menuItemsFor = (node: FileNode | null): TreeMenuItem[] => {
    if (!node) {
      return [
        { id: "new-file", label: "New File…", onSelect: () => { void startCreate(false, null, 0); } },
        { id: "new-folder", label: "New Folder…", onSelect: () => { void startCreate(true, null, 0); } },
        { id: "refresh", label: "Refresh", dividerBefore: true, onSelect: () => { void refreshTree(); } },
        { id: "collapse", label: "Collapse Folders", onSelect: collapseAll },
      ];
    }
    if (node.isDirectory) {
      return [
        { id: "new-file", label: "New File…", onSelect: () => { void startCreate(false, node.path, depthOf(node.path) + 1); } },
        { id: "new-folder", label: "New Folder…", onSelect: () => { void startCreate(true, node.path, depthOf(node.path) + 1); } },
        {
          id: "toggle", label: node.children ? "Collapse Folder" : "Expand Folder", dividerBefore: true,
          onSelect: () => { void toggleDirectory(node.path); },
        },
        { id: "rename", label: "Rename…", shortcut: "F2", dividerBefore: true, onSelect: () => startRename(node) },
        { id: "delete", label: "Delete", shortcut: "Del", danger: true, onSelect: () => { void confirmDelete(node); } },
        { id: "copy-path", label: "Copy Path", dividerBefore: true, onSelect: () => { void copyPath(node, false); } },
        { id: "copy-relative", label: "Copy Relative Path", onSelect: () => { void copyPath(node, true); } },
      ];
    }
    return [
      { id: "open", label: "Open", onSelect: () => { void openFile(node.path); } },
      { id: "rename", label: "Rename…", shortcut: "F2", dividerBefore: true, onSelect: () => startRename(node) },
      { id: "delete", label: "Delete", shortcut: "Del", danger: true, onSelect: () => { void confirmDelete(node); } },
      { id: "copy-path", label: "Copy Path", dividerBefore: true, onSelect: () => { void copyPath(node, false); } },
      { id: "copy-relative", label: "Copy Relative Path", onSelect: () => { void copyPath(node, true); } },
    ];
  };

  const onRowClick = (node: FileNode): void => {
    setSelectedPath(node.path);
    if (node.isDirectory) void toggleDirectory(node.path);
    else void openFile(node.path);
  };

  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!selectedPath || inline) return;
    const node = findNode(fileTree, selectedPath);
    if (!node) return;
    if (event.key === "F2") { event.preventDefault(); startRename(node); }
    else if (event.key === "Delete") { event.preventDefault(); void confirmDelete(node); }
  };

  const ui: TreeUi = {
    selectedPath, inline, onRowClick,
    onRowMenu: openMenu,
    onCommit: (value) => { void commitInline(value); },
    onCancel: cancelInline,
  };

  return (
    <aside className="explorer-panel">
      <div className="panel-title explorer-header">
        <span className="explorer-title">EXPLORER</span>
        {folderPath && (
          <div className="tree-actions">
            <button
              className="tree-action"
              title="New File"
              aria-label="New File"
              onClick={() => { const target = creationTarget(selectedPath); void startCreate(false, target.parentPath, target.depth); }}
            >
              <TreeIcon name="new-file" />
            </button>
            <button
              className="tree-action"
              title="New Folder"
              aria-label="New Folder"
              onClick={() => { const target = creationTarget(selectedPath); void startCreate(true, target.parentPath, target.depth); }}
            >
              <TreeIcon name="new-folder" />
            </button>
            <button className="tree-action" title="Refresh Explorer" aria-label="Refresh Explorer" onClick={() => { void refreshTree(); }}>
              <TreeIcon name="refresh" />
            </button>
            <button className="tree-action" title="Collapse Folders" aria-label="Collapse Folders" onClick={collapseAll}>
              <TreeIcon name="collapse" />
            </button>
          </div>
        )}
      </div>

      {!folderPath ? (
        <div className="explorer-empty">
          <p>You have not yet opened a folder.</p>
          <button className="primary-button" onClick={() => void openFolder()}>Open Folder</button>
        </div>
      ) : (
        <div
          className="tree"
          role="tree"
          tabIndex={0}
          aria-label={`${folderName ?? "Workspace"} file tree`}
          onKeyDown={onTreeKeyDown}
          onContextMenu={(event) => openMenu(event, null)}
        >
          <div className="workspace-heading" onContextMenu={(event) => openMenu(event, null)}>
            <span>⌄</span>{folderName}
          </div>
          {inline?.kind === "create" && inline.parentPath === null && (
            <InlineInput
              depth={0}
              initialValue=""
              isDirectory={inline.isDirectory}
              ariaLabel={inline.isDirectory ? "New folder name" : "New file name"}
              onCommit={(value) => { void commitInline(value); }}
              onCancel={cancelInline}
            />
          )}
          {fileTree.map((node) => <TreeNode key={node.path} node={node} depth={0} ui={ui} />)}
          {fileTree.length === 0 && !inline && (
            <p className="tree-empty-hint">This folder is empty. Use the toolbar or right-click to add a file.</p>
          )}
        </div>
      )}

      {menu && <TreeContextMenu position={menu.position} items={menuItemsFor(menu.node)} onClose={() => setMenu(null)} />}
    </aside>
  );
}
