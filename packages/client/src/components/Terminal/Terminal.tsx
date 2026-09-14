import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { useUiStore } from "../../stores/useUiStore";
import { useWorkspaceStore } from "../../stores/useWorkspaceStore";
import { NEW_TERMINAL_EVENT } from "../CommandPalette/CommandPalette";

interface Session {
  id: string;
  title: string;
  shell: string;
  cwd: string;
  exited: boolean;
}

interface Instance {
  term: XTerm;
  fit: FitAddon;
}

const shellLabel = (shell: string): string => {
  const base = shell.split(/[\\/]/).pop() ?? shell;
  return base.replace(/\.exe$/i, "");
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// xterm measures glyphs on a canvas, so this has to be a real font stack —
// a CSS variable would not resolve there.
const TERMINAL_FONT_FAMILY =
  '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, "Courier New", monospace';

const TERMINAL_THEME = {
  background: "#1e1e1e",
  foreground: "#cccccc",
  cursor: "#aeafad",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

/**
 * The bottom panel. Each tab owns one node-pty session in the main process and
 * one xterm.js instance here; keystrokes travel over IPC one way and output
 * comes back over a push channel the other way.
 */
export function Terminal() {
  const open = useUiStore((state) => state.bottomPanelOpen);
  const height = useUiStore((state) => state.bottomPanelHeight);
  const toggleBottomPanel = useUiStore((state) => state.toggleBottomPanel);
  const setBottomPanelHeight = useUiStore((state) => state.setBottomPanelHeight);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const instances = useRef(new Map<string, Instance>());
  const refCallbacks = useRef(new Map<string, (element: HTMLDivElement | null) => void>());
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bootstrapped = useRef(false);

  const fitSession = useCallback((id: string) => {
    const instance = instances.current.get(id);
    if (!instance) return;
    const dimensions = instance.fit.proposeDimensions();
    if (!dimensions || dimensions.cols < 2 || dimensions.rows < 1) return;
    instance.fit.fit();
  }, []);

  const disposeInstance = useCallback((id: string) => {
    const instance = instances.current.get(id);
    if (!instance) return;
    instances.current.delete(id);
    instance.term.dispose();
  }, []);

  /**
   * One stable ref callback per session. A fresh callback on every render
   * would make React detach and re-attach (and therefore dispose and recreate)
   * the xterm instance on every state change.
   */
  const attach = useCallback(
    (id: string) => {
      const cached = refCallbacks.current.get(id);
      if (cached) return cached;

      const callback = (element: HTMLDivElement | null) => {
        if (!element) {
          disposeInstance(id);
          return;
        }
        if (instances.current.has(id)) return;

        const term = new XTerm({
          convertEol: false,
          cursorBlink: true,
          fontFamily: TERMINAL_FONT_FAMILY,
          fontSize: 13,
          lineHeight: 1.2,
          scrollback: 5000,
          theme: TERMINAL_THEME,
          allowProposedApi: true,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(element);
        // xterm -> pty
        term.onData((data) => {
          void window.forge.terminalWrite({ id, data }).catch(() => undefined);
        });
        // tell the pty about size changes (FitAddon.fit() triggers this)
        term.onResize(({ cols, rows }) => {
          void window.forge.terminalResize({ id, cols, rows }).catch(() => undefined);
        });

        instances.current.set(id, { term, fit });
        fitSession(id);
      };

      refCallbacks.current.set(id, callback);
      return callback;
    },
    [disposeInstance, fitSession],
  );

  const createSession = useCallback(async () => {
    try {
      setError(null);
      // new shells start in the open folder, like they do in VS Code
      const cwd = useWorkspaceStore.getState().folderPath ?? undefined;
      const info = await window.forge.terminalCreate(cwd ? { cwd } : {});
      setSessions((previous) => [
        ...previous,
        { id: info.id, title: shellLabel(info.shell), shell: info.shell, cwd: info.cwd, exited: false },
      ]);
      setActiveId(info.id);
    } catch (createError) {
      setError(errorMessage(createError));
    }
  }, []);

  const killSession = useCallback(
    async (id: string) => {
      await window.forge.terminalKill({ id }).catch(() => undefined);
      disposeInstance(id);
      refCallbacks.current.delete(id);
      setSessions((previous) => previous.filter((session) => session.id !== id));
    },
    [disposeInstance],
  );

  // keep a valid active tab at all times
  useEffect(() => {
    const last = sessions[sessions.length - 1]?.id ?? null;
    if (activeId !== null && sessions.some((session) => session.id === activeId)) return;
    setActiveId(last);
  }, [activeId, sessions]);

  // Command palette's "New Terminal" action dispatches through here, reusing
  // the exact same spawn path as the panel's own "+" button.
  useEffect(() => {
    const onNewTerminal = () => { void createSession(); };
    window.addEventListener(NEW_TERMINAL_EVENT, onNewTerminal);
    return () => window.removeEventListener(NEW_TERMINAL_EVENT, onNewTerminal);
  }, [createSession]);

  // one terminal to start with
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void createSession();
  }, [createSession]);

  // pty -> xterm
  useEffect(() => {
    const offData = window.forge.onTerminalData(({ id, data }) => {
      instances.current.get(id)?.term.write(data);
    });
    const offExit = window.forge.onTerminalExit(({ id, exitCode }) => {
      const instance = instances.current.get(id);
      instance?.term.write(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`);
      setSessions((previous) =>
        previous.map((session) => (session.id === id ? { ...session, exited: true } : session)),
      );
    });
    return () => {
      offData();
      offExit();
    };
  }, []);

  // Ctrl/Cmd + ` toggles the panel
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && (event.key === "`" || event.code === "Backquote")) {
        event.preventDefault();
        toggleBottomPanel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleBottomPanel]);

  // keep the visible terminal sized to its container
  useEffect(() => {
    if (!open || !activeId) return;
    const frame = requestAnimationFrame(() => fitSession(activeId));
    return () => cancelAnimationFrame(frame);
  }, [open, activeId, height, fitSession]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!open || !activeId) return;
      fitSession(activeId);
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, [open, activeId, fitSession]);

  // focus the active terminal when it becomes visible
  useEffect(() => {
    if (!open || !activeId) return;
    instances.current.get(activeId)?.term.focus();
  }, [open, activeId, sessions]);

  useEffect(() => {
    const killAll = () => {
      for (const session of sessions) void window.forge.terminalKill({ id: session.id }).catch(() => undefined);
    };
    window.addEventListener("beforeunload", killAll);
    return () => window.removeEventListener("beforeunload", killAll);
  }, [sessions]);

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = height;
    const move = (moveEvent: PointerEvent) => setBottomPanelHeight(startHeight + (startY - moveEvent.clientY));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return (
    <section className="terminal-panel" style={{ height: open ? height : 0 }} aria-hidden={!open}>
      <div
        className="panel-resizer-horizontal"
        onPointerDown={startResize}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal panel"
      />
      <header className="terminal-header">
        <div className="terminal-tabs" role="tablist" aria-label="Terminals">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`terminal-tab ${session.id === activeId ? "active" : ""}`}
              onClick={() => setActiveId(session.id)}
              role="tab"
              aria-selected={session.id === activeId}
              title={session.cwd}
            >
              <span className="terminal-tab-icon">›_</span>
              <span className="terminal-tab-title">
                {session.title}
                {session.exited ? " (exited)" : ""}
              </span>
              <span
                className="terminal-tab-close"
                role="button"
                aria-label={`Kill terminal ${session.title}`}
                onClick={(clickEvent) => {
                  clickEvent.stopPropagation();
                  void killSession(session.id);
                }}
              >
                ×
              </span>
            </button>
          ))}
          <button className="terminal-action" onClick={() => void createSession()} title="New Terminal" aria-label="New Terminal">
            +
          </button>
        </div>
        <div className="terminal-actions">
          <button
            className="terminal-action"
            onClick={() => activeId && void killSession(activeId)}
            title="Kill the active terminal"
            aria-label="Kill the active terminal"
            disabled={!activeId}
          >
            ⌫
          </button>
          <button
            className="terminal-action"
            onClick={toggleBottomPanel}
            title="Close panel (Ctrl+`)"
            aria-label="Close terminal panel"
          >
            ×
          </button>
        </div>
      </header>
      {error && <p className="terminal-error">{error}</p>}
      <div className="terminal-body" ref={bodyRef}>
        {sessions.map((session) => (
          <div
            key={session.id}
            ref={attach(session.id)}
            className="terminal-view"
            style={{ display: session.id === activeId ? "block" : "none" }}
          />
        ))}
      </div>
    </section>
  );
}
