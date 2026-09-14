import MonacoEditor, { type OnMount } from "@monaco-editor/react";
import { useEffect } from "react";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";

const fileName = (filePath: string) => filePath.split(/[\\/]/).pop() ?? filePath;

export function Editor() {
  const tabs = useWorkspaceStore((state) => state.openTabs);
  const activeTabId = useWorkspaceStore((state) => state.activeTabId);
  const contents = useWorkspaceStore((state) => state.contents);
  const folderPath = useWorkspaceStore((state) => state.folderPath);
  const setActiveTab = useWorkspaceStore((state) => state.setActiveTab);
  const closeTab = useWorkspaceStore((state) => state.closeTab);
  const updateContent = useWorkspaceStore((state) => state.updateContent);
  const saveActiveFile = useWorkspaceStore((state) => state.saveActiveFile);
  const setCursorPosition = useWorkspaceStore((state) => state.setCursorPosition);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveActiveFile();
      }
    };
    window.addEventListener("keydown", save);
    return () => window.removeEventListener("keydown", save);
  }, [saveActiveFile]);

  const handleMount: OnMount = (editor) => {
    editor.onDidChangeCursorPosition(({ position }) => setCursorPosition(position.lineNumber, position.column));
    editor.focus();
  };

  return (
    <main className="editor-group">
      {tabs.length > 0 && (
        <div className="tab-bar" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`editor-tab ${tab.id === activeTabId ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              role="tab"
              aria-selected={tab.id === activeTabId}
              title={tab.filePath}
            >
              <span className="file-type-icon">◇</span>
              <span>{fileName(tab.filePath)}</span>
              {tab.isDirty && <span className="dirty-dot" title="Unsaved changes" />}
              <span
                className="tab-close"
                role="button"
                aria-label={`Close ${fileName(tab.filePath)}`}
                onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}
              >×</span>
            </button>
          ))}
        </div>
      )}
      <div className="editor-surface">
        {activeTab ? (
          <MonacoEditor
            key={activeTab.id}
            path={activeTab.filePath}
            language={activeTab.language}
            value={contents[activeTab.id] ?? ""}
            theme="vs-dark"
            onChange={(value) => updateContent(activeTab.id, value ?? "")}
            onMount={handleMount}
            options={{
              automaticLayout: true,
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              lineHeight: 20,
              minimap: { enabled: true },
              smoothScrolling: true,
              padding: { top: 8 },
              renderWhitespace: "selection",
              cursorBlinking: "smooth",
            }}
          />
        ) : (
          <div className="editor-empty">
            <div className="forge-mark">F</div>
            <h1>Forge</h1>
            <p>{folderPath ? "Select a file to start editing" : "Open a folder to get started"}</p>
            <div className="shortcut"><span>Show All Commands</span><kbd>⇧⌘P</kbd></div>
            <div className="shortcut"><span>Quick Open File</span><kbd>⌘P</kbd></div>
          </div>
        )}
      </div>
    </main>
  );
}
