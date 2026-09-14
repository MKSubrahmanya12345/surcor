import { useEffect, useMemo, useState } from "react";
import type { AgentMode, FileNode } from "@forge/shared";
import { useChatStore } from "../../stores/useChatStore";
import { useUiStore } from "../../stores/useUiStore";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { fuzzyFilter } from "./fuzzy";

/**
 * Prompt 6, Part B — command palette (Cmd/Ctrl+Shift+P) and quick file open
 * (Cmd/Ctrl+P), one overlay component with two modes. Typing ">" in quick-open
 * mode switches to commands, mirroring VS Code.
 */

export const FOCUS_CHAT_EVENT = "forge:focus-chat";
export const NEW_TERMINAL_EVENT = "forge:new-terminal";

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

function useCommands(): CommandItem[] {
  return useMemo(() => {
    const ui = useUiStore.getState;
    const chat = useChatStore.getState;
    const workspace = useWorkspaceStore.getState;
    const close = (): void => ui().setPaletteMode("closed");

    const modeCommand = (mode: AgentMode, label: string): CommandItem => ({
      id: `mode-${mode}`,
      label,
      hint: "Chat panel",
      run: () => {
        chat().setMode(mode);
        ui().setChatOpen(true);
      },
    });

    return [
      {
        id: "open-folder",
        label: "Open Folder…",
        hint: "workspace",
        run: () => { void workspace().openFolder(); },
      },
      {
        id: "toggle-terminal",
        label: "Toggle Terminal",
        hint: "Ctrl+`",
        run: () => ui().toggleBottomPanel(),
      },
      {
        id: "toggle-chat",
        label: "Toggle Chat Panel",
        hint: "right side",
        run: () => ui().toggleChat(),
      },
      modeCommand("ask", "Agent Mode: Ask"),
      modeCommand("agent", "Agent Mode: Agent"),
      modeCommand("plan", "Agent Mode: Plan"),
      {
        id: "new-terminal",
        label: "New Terminal",
        hint: "bottom panel",
        run: () => {
          ui().setBottomPanelOpen(true);
          window.dispatchEvent(new Event(NEW_TERMINAL_EVENT));
        },
      },
      {
        id: "clone-repository",
        label: "Clone Repository…",
        hint: "GitHub",
        run: () => {
          ui().setSidebarView("source-control");
        },
      },
      {
        id: "toggle-sidebar",
        label: "Toggle File Tree",
        hint: "Ctrl+B",
        run: () => ui().toggleSidebar(),
      },
      {
        id: "focus-chat",
        label: "Focus Chat Input",
        hint: "Ctrl+L",
        run: () => {
          ui().setChatOpen(true);
          window.dispatchEvent(new Event(FOCUS_CHAT_EVENT));
        },
      },
      {
        id: "open-mcp-settings",
        label: "Open MCP Settings",
        hint: "~/.forge/mcp.json",
        run: () => ui().setSidebarView("settings"),
      },
    ].map((command) => ({ ...command, run: () => { close(); command.run(); } }));
  }, []);
}

function flattenFiles(nodes: FileNode[], out: FileNode[] = []): FileNode[] {
  for (const node of nodes) {
    if (node.isDirectory) {
      if (node.children) flattenFiles(node.children, out);
    } else {
      out.push(node);
    }
  }
  return out;
}

export function CommandPalette() {
  const paletteMode = useUiStore((state) => state.paletteMode);
  const setPaletteMode = useUiStore((state) => state.setPaletteMode);
  const fileTree = useWorkspaceStore((state) => state.fileTree);
  const openFile = useWorkspaceStore((state) => state.openFile);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const commands = useCommands();
  const commandMode = paletteMode === "commands" || query.startsWith(">");
  const rawQuery = commandMode && paletteMode === "files" ? query.slice(1) : query;

  const items = useMemo(() => {
    if (paletteMode === "closed") return [] as { id: string; primary: string; secondary?: string }[];
    if (commandMode) {
      return fuzzyFilter(rawQuery, commands, (command) => command.label)
        .map((command) => ({ id: command.id, primary: command.label, secondary: command.hint }));
    }
    return fuzzyFilter(query, flattenFiles(fileTree), (node) => node.path)
      .slice(0, 200)
      .map((node) => ({ id: node.path, primary: node.name, secondary: node.path }));
  }, [paletteMode, commandMode, rawQuery, query, commands, fileTree]);

  useEffect(() => { setSelected(0); }, [items.length, paletteMode, query]);
  useEffect(() => {
    if (paletteMode !== "closed") setQuery("");
  }, [paletteMode]);

  if (paletteMode === "closed") return null;

  const close = (): void => setPaletteMode("closed");

  const activate = (index: number): void => {
    const item = items[index];
    if (!item) return;
    if (commandMode) {
      const command = fuzzyFilter(rawQuery, commands, (entry) => entry.label)[index];
      command?.run();
    } else {
      close();
      void openFile(item.id);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "ArrowDown") { event.preventDefault(); setSelected((value) => Math.min(items.length - 1, value + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setSelected((value) => Math.max(0, value - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); activate(selected); }
    else if (event.key === "Escape") { event.preventDefault(); close(); }
  };

  return (
    <div className="palette-backdrop" onClick={close}>
      <div className="palette" role="dialog" aria-label={commandMode ? "Command palette" : "Quick file open"} onClick={(event) => event.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={commandMode ? "Type a command…" : "Type a file name… (\">\" for commands)"}
        />
        <div className="palette-list" role="listbox">
          {items.length === 0 && (
            <div className="palette-empty">
              {commandMode
                ? "No matching commands."
                : fileTree.length === 0
                  ? "No folder open — run “Open Folder…” first."
                  : "No matching loaded files. Expand folders in the Explorer to index them here."}
            </div>
          )}
          {items.map((item, index) => (
            <button
              key={item.id}
              className={`palette-item ${index === selected ? "active" : ""}`}
              role="option"
              aria-selected={index === selected}
              onMouseEnter={() => setSelected(index)}
              onClick={() => activate(index)}
            >
              <span className="palette-item-primary">{item.primary}</span>
              {item.secondary && <span className="palette-item-secondary">{item.secondary}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
