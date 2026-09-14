import { DiffEditor } from "@monaco-editor/react";
import type { GitDiff } from "@forge/shared";

const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  md: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  sh: "shell",
  bash: "shell",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  sql: "sql",
  toml: "ini",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
};

const languageForPath = (filePath: string): string => {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGES[extension] ?? "plaintext";
};

const fileName = (filePath: string): string => filePath.split(/[\\/]/).pop() ?? filePath;

export function DiffViewer({
  diff,
  onClose,
  onOpenFile,
}: {
  diff: GitDiff;
  onClose: () => void;
  onOpenFile: () => void;
}) {
  return (
    <section className="scm-diff">
      <header className="scm-diff-header">
        <span className="scm-diff-name" title={diff.filePath}>
          {fileName(diff.filePath)}
        </span>
        <span className="scm-diff-badge">{diff.isUntracked ? "New" : diff.staged ? "Staged" : "Unstaged"}</span>
        <span className="scm-diff-actions">
          <button className="scm-icon-button" title="Open file" aria-label="Open file" onClick={onOpenFile}>
            ⤴
          </button>
          <button className="scm-icon-button" title="Close diff" aria-label="Close diff" onClick={onClose}>
            ×
          </button>
        </span>
      </header>
      {diff.isBinary ? (
        <p className="scm-hint scm-diff-binary">Binary file — contents are not shown.</p>
      ) : (
        <div className="scm-diff-surface">
          <DiffEditor
            original={diff.original}
            modified={diff.modified}
            language={languageForPath(diff.filePath)}
            theme="vs-dark"
            options={{
              readOnly: true,
              automaticLayout: true,
              renderSideBySide: false,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              renderOverviewRuler: false,
              fontSize: 12,
              lineHeight: 18,
              lineNumbers: "off",
              folding: false,
              glyphMargin: false,
              renderWhitespace: "none",
              scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
            }}
          />
        </div>
      )}
      {diff.truncated && <p className="scm-hint scm-diff-binary">File truncated for display.</p>}
    </section>
  );
}
