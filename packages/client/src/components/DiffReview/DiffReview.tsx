import { DiffEditor } from "@monaco-editor/react";
import { useState } from "react";
import { useChatStore } from "../../stores/useChatStore";

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  json: "json", css: "css", scss: "scss", html: "html", md: "markdown",
  py: "python", rs: "rust", go: "go", java: "java", c: "c", cpp: "cpp",
  h: "c", hpp: "cpp", sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml",
  xml: "xml", sql: "sql", toml: "ini",
};

const languageForPath = (filePath: string): string => {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXTENSION[extension] ?? "plaintext";
};

const shortName = (filePath: string): string => filePath.split(/[\\/]/).pop() ?? filePath;

/**
 * Rendered while at least one diff_proposed ServerMessage is pending.
 * Accept writes through Prompt 1's fs:writeFile IPC handler (the only
 * file-write path) and then tells the server the decision; Reject only
 * sends the diff_decision ClientMessage.
 */
export function DiffReview() {
  const pendingDiffs = useChatStore((state) => state.pendingDiffs);
  const decideDiff = useChatStore((state) => state.decideDiff);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const active = pendingDiffs.find((diff) => diff.id === selectedId) ?? pendingDiffs[0];
  if (!active) return null;

  return (
    <div className="diff-review" aria-label="Proposed change review">
      <header className="diff-review-header">
        <span className="diff-review-title">Review proposed change</span>
        {pendingDiffs.length > 1 && (
          <div className="diff-review-tabs">
            {pendingDiffs.map((diff) => (
              <button
                key={diff.id}
                type="button"
                className={`diff-review-tab ${diff.id === active.id ? "active" : ""}`}
                title={diff.filePath}
                onClick={() => setSelectedId(diff.id)}
              >
                {shortName(diff.filePath)}
              </button>
            ))}
          </div>
        )}
      </header>
      <div className="diff-review-path" title={active.filePath}>{active.filePath}</div>
      <div className="diff-review-surface">
        <DiffEditor
          original={active.originalContent}
          modified={active.proposedContent}
          language={languageForPath(active.filePath)}
          theme="vs-dark"
          options={{
            renderSideBySide: true,
            readOnly: true,
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 12,
            lineHeight: 18,
            scrollBeyondLastLine: false,
            overviewRulerLanes: 0,
            contextmenu: false,
          }}
        />
      </div>
      <footer className="diff-review-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => void decideDiff(active.id, "reject")}
        >
          Reject
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => void decideDiff(active.id, "accept")}
        >
          Accept
        </button>
      </footer>
    </div>
  );
}
