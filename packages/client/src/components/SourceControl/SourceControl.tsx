import { useEffect, useMemo, useState } from "react";
import type { GitFileStatus, GitFileStatusCode } from "@forge/shared";
import { useGitStore } from "../../stores/useGitStore";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { GitHubConnect } from "../GitHubConnect/GitHubConnect";
import { DiffViewer } from "./DiffViewer";

const STATUS_LETTER: Record<GitFileStatusCode, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "U",
  unmerged: "!",
  unknown: "?",
};

const REFRESH_INTERVAL_MS = 10_000;
const SAVE_DEBOUNCE_MS = 1_200;

const baseName = (filePath: string): string => filePath.split(/[\\/]/).pop() ?? filePath;
const dirName = (filePath: string): string => {
  const parts = filePath.split(/[\\/]/);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
};

function FileRow({
  file,
  disabled,
  isActive,
  onOpen,
  onDiscard,
  onStageToggle,
}: {
  file: GitFileStatus;
  disabled: boolean;
  isActive: boolean;
  onOpen: () => void;
  onDiscard: () => void;
  onStageToggle: () => void;
}) {
  return (
    <div className={`scm-file-row ${isActive ? "active" : ""}`}>
      <button className="scm-file-label" onClick={onOpen} title={file.path} disabled={disabled}>
        <span className={`scm-file-badge ${file.status}`}>{STATUS_LETTER[file.status]}</span>
        <span className="scm-file-name">{baseName(file.path)}</span>
        <span className="scm-file-path">{dirName(file.path)}</span>
      </button>
      <span className="scm-file-actions">
        <button
          className="scm-icon-button"
          title={file.staged ? "Unstage changes" : "Stage changes"}
          aria-label={file.staged ? "Unstage changes" : "Stage changes"}
          disabled={disabled}
          onClick={onStageToggle}
        >
          {file.staged ? "−" : "+"}
        </button>
        <button
          className="scm-icon-button"
          title="Discard changes"
          aria-label="Discard changes"
          disabled={disabled}
          onClick={onDiscard}
        >
          ↺
        </button>
      </span>
    </div>
  );
}

export function SourceControl() {
  const folderPath = useWorkspaceStore((state) => state.folderPath);
  const openFile = useWorkspaceStore((state) => state.openFile);

  const status = useGitStore((state) => state.status);
  const branch = useGitStore((state) => state.branch);
  const diff = useGitStore((state) => state.diff);
  const loading = useGitStore((state) => state.loading);
  const busy = useGitStore((state) => state.busy);
  const error = useGitStore((state) => state.error);
  const notice = useGitStore((state) => state.notice);
  const refresh = useGitStore((state) => state.refresh);
  const openDiff = useGitStore((state) => state.openDiff);
  const closeDiff = useGitStore((state) => state.closeDiff);
  const stage = useGitStore((state) => state.stage);
  const unstage = useGitStore((state) => state.unstage);
  const discard = useGitStore((state) => state.discard);
  const commit = useGitStore((state) => state.commit);
  const push = useGitStore((state) => state.push);
  const pull = useGitStore((state) => state.pull);
  const clearMessages = useGitStore((state) => state.clearMessages);

  const [message, setMessage] = useState("");

  useEffect(() => {
    void refresh();
  }, [folderPath, refresh]);

  // poll while the panel is open and re-check when the window regains focus
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (useWorkspaceStore.getState().folderPath) void refresh();
    }, REFRESH_INTERVAL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  // refresh shortly after files are edited or saved
  useEffect(() => {
    let timer: number | undefined;
    let signature = "";
    const unsubscribe = useWorkspaceStore.subscribe((state) => {
      const next = `${state.folderPath}#${state.openTabs
        .map((tab) => `${tab.filePath}:${tab.isDirty ? 1 : 0}`)
        .join("|")}`;
      if (next === signature) return;
      signature = next;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), SAVE_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, [refresh]);

  const { staged, unstaged } = useMemo(() => {
    const files = status?.files ?? [];
    return {
      staged: files.filter((file) => file.staged),
      unstaged: files.filter((file) => !file.staged),
    };
  }, [status]);

  if (!folderPath) {
    return (
      <aside className="scm-panel">
        <div className="panel-title">SOURCE CONTROL</div>
        <div className="scm-empty">
          <p>No folder is open, so there is nothing to track.</p>
        </div>
        <GitHubConnect />
      </aside>
    );
  }

  if (status && !status.isRepository) {
    return (
      <aside className="scm-panel">
        <div className="panel-title">SOURCE CONTROL</div>
        <div className="scm-empty">
          <p>This folder is not a git repository.</p>
          <p className="scm-hint">Run `git init` in the terminal below to start tracking it.</p>
        </div>
        <GitHubConnect />
      </aside>
    );
  }

  const count = staged.length + unstaged.length;
  const canCommit = !busy && count > 0 && message.trim().length > 0;
  const ahead = branch?.ahead ?? 0;
  const behind = branch?.behind ?? 0;

  return (
    <aside className="scm-panel">
      <div className="panel-title scm-panel-title">
        <span>SOURCE CONTROL</span>
        <span className="panel-title-actions">
          <button
            className="scm-icon-button"
            title="Refresh"
            aria-label="Refresh source control"
            onClick={() => void refresh()}
            disabled={loading}
          >
            ↻
          </button>
          <button
            className="scm-icon-button"
            title="Stage all changes"
            aria-label="Stage all changes"
            disabled={busy || unstaged.length === 0}
            onClick={() => void stage(unstaged.map((file) => file.path))}
          >
            +
          </button>
          <button
            className="scm-icon-button"
            title="Unstage all changes"
            aria-label="Unstage all changes"
            disabled={busy || staged.length === 0}
            onClick={() => void unstage(staged.map((file) => file.path))}
          >
            −
          </button>
        </span>
      </div>

      <div className="scm-commit-box">
        <textarea
          className="scm-message-input"
          placeholder={`Message (${count} change${count === 1 ? "" : "s"}) — Ctrl+Enter to commit`}
          rows={3}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canCommit) {
              event.preventDefault();
              void commit(message, false).then((ok) => ok && setMessage(""));
            }
          }}
        />
        <div className="scm-commit-actions">
          <button
            className="primary-button"
            disabled={!canCommit}
            onClick={() => void commit(message, false).then((ok) => ok && setMessage(""))}
          >
            Commit
          </button>
          <button
            className="secondary-button"
            disabled={!canCommit}
            onClick={() => void commit(message, true).then((ok) => ok && setMessage(""))}
          >
            Commit &amp; Push
          </button>
        </div>
        {(ahead > 0 || behind > 0) && (
          <div className="scm-sync-row">
            <span className="scm-sync-count">
              {behind > 0 ? `↓${behind} ` : ""}
              {ahead > 0 ? `↑${ahead}` : ""}
            </span>
            <button className="secondary-button" disabled={busy} onClick={() => void pull()}>
              Pull
            </button>
            <button className="secondary-button" disabled={busy || ahead === 0} onClick={() => void push()}>
              Push
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className="scm-message error" role="alert">
          {error}
          <button className="scm-dismiss" aria-label="Dismiss" onClick={clearMessages}>
            ×
          </button>
        </p>
      )}
      {notice && !error && (
        <p className="scm-message notice">
          {notice}
          <button className="scm-dismiss" aria-label="Dismiss" onClick={clearMessages}>
            ×
          </button>
        </p>
      )}

      <div className="scm-file-lists">
        <section className="scm-section">
          <header className="scm-section-title">
            <span>STAGED CHANGES</span>
            <span className="scm-count">{staged.length}</span>
          </header>
          {staged.map((file) => (
            <FileRow
              key={`staged:${file.path}`}
              file={file}
              disabled={busy}
              isActive={diff?.filePath === file.path && diff.staged}
              onOpen={() => void openDiff(file.path, true)}
              onStageToggle={() => void unstage([file.path])}
              onDiscard={() => void discard([file.path])}
            />
          ))}
        </section>

        <section className="scm-section">
          <header className="scm-section-title">
            <span>CHANGES</span>
            <span className="scm-count">{unstaged.length}</span>
          </header>
          {unstaged.map((file) => (
            <FileRow
              key={`unstaged:${file.path}`}
              file={file}
              disabled={busy}
              isActive={diff?.filePath === file.path && !diff.staged}
              onOpen={() => void openDiff(file.path, false)}
              onStageToggle={() => void stage([file.path])}
              onDiscard={() => void discard([file.path])}
            />
          ))}
        </section>

        {status && count === 0 && <p className="scm-hint scm-clean">No changes in this workspace.</p>}
      </div>

      {diff && <DiffViewer diff={diff} onClose={closeDiff} onOpenFile={() => void openFile(diff.absolutePath)} />}

      <GitHubConnect />
    </aside>
  );
}
