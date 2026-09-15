import { useEffect, useRef, useState } from "react";
import "@google/model-viewer";
import type { CadModelResult, CadProgressEvent } from "@forge/shared";
import { useChatStore } from "../../stores/useChatStore";

/**
 * Prompt 7 — CAD mode panel.
 *
 * Rendered inside ChatPanel while the mode switcher says `cad`, reusing
 * Prompt 1's `#panel-right-slot` (no new slot, no new layout branch). It shows
 * the three things the CAD protocol carries: real stage progress as it happens,
 * the verified model in an orbitable viewer, or the specific reason nothing was
 * produced. There is no fourth state — the pipeline cannot hand back a
 * placeholder, so the panel never has to render one.
 */

const STAGE_LABELS: Record<CadProgressEvent["stage"], string> = {
  searching_existing: "SEARCH",
  spec_planning: "SPEC",
  architecting: "ARCHITECT",
  coding: "CODE",
  qa_pass: "QA",
  converting: "MESH",
};

const STAGE_ORDER: CadProgressEvent["stage"][] = [
  "searching_existing", "spec_planning", "architecting", "coding", "qa_pass", "converting",
];

interface ArtifactEndpoint {
  origin: string;
  token?: string;
}

/**
 * The renderer only ever reaches the agent server through the socket (see
 * services/agentSocket.ts); a `<model-viewer src>` and a download link are the
 * one place a plain HTTP URL is needed, so it is derived from the very same
 * configured endpoint — never hardcoded to another port.
 */
const artifactEndpoint = (): ArtifactEndpoint => {
  const configured = (import.meta.env.VITE_FORGE_AGENT_URL as string | undefined)?.trim();
  const token = (import.meta.env.VITE_FORGE_AGENT_TOKEN as string | undefined)?.trim();
  let origin = "http://localhost:4500";
  if (configured) {
    try {
      const url = new URL(configured);
      origin = `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
    } catch {
      /* keep the default; the socket layer reports a bad URL itself */
    }
  }
  return { origin, ...(token ? { token } : {}) };
};

const artifactUrl = (absolutePath: string, download = false): string => {
  const { origin, token } = artifactEndpoint();
  const url = new URL(`${origin}/cad/artifact`);
  url.searchParams.set("path", absolutePath);
  if (token) url.searchParams.set("token", token);
  if (download) url.searchParams.set("dl", "1");
  return url.toString();
};

const timeOfDay = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function CADPanel() {
  const cad = useChatStore((state) => state.cad);
  const ready = useChatStore((state) => state.ready);
  const requestCadModel = useChatStore((state) => state.requestCadModel);
  const clearCad = useChatStore((state) => state.clearCad);
  const cancelTurn = useChatStore((state) => state.cancelTurn);

  const [refining, setRefining] = useState(false);
  const [refineText, setRefineText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [cad.progress]);

  useEffect(() => {
    if (!cad.failure) setRefining(false);
  }, [cad.failure]);

  const startRefine = (): void => {
    setRefineText(`${cad.prompt}\n\nMore detail: `);
    setRefining(true);
  };

  const submitRefine = (): void => {
    const text = refineText.trim();
    if (!text || cad.running) return;
    setRefining(false);
    requestCadModel(text);
  };

  const stages = new Set(cad.progress.map((line) => line.stage));
  const activeStage = STAGE_ORDER.filter((stage) => stages.has(stage)).pop();
  const result: CadModelResult | null = cad.result;

  return (
    <section className="cad-panel" aria-label="CAD text-to-model">
      <header className="cad-header">
        <span className={`cad-state ${cad.running ? "running" : result ? "ready" : cad.failure ? "failed" : ""}`}>
          {cad.running ? "RUNNING" : result ? "VERIFIED" : cad.failure ? "REFUSED" : "IDLE"}
        </span>
        <span className="cad-header-title">{cad.prompt ? `“${cad.prompt}”` : "CAD mode"}</span>
        {(cad.running || cad.progress.length > 0) && (
          <button
            type="button"
            className="cad-ghost-button"
            onClick={() => (cad.running ? cancelTurn() : clearCad())}
            title={cad.running ? "Stop the MAC job and clear this run" : "Clear this CAD run"}
          >
            {cad.running ? "stop" : "clear"}
          </button>
        )}
      </header>

      {!ready && (
        <p className="cad-note">
          The agent server is not connected, so no CAD request can start.
        </p>
      )}

      {cad.progress.length > 0 && (
        <div className="cad-log" ref={logRef} role="log" aria-live="polite">
          {cad.progress.map((line, index) => (
            <div key={`${line.at}-${index}`} className={`cad-log-line ${index === cad.progress.length - 1 && cad.running ? "latest" : ""}`}>
              <span className={`cad-stage ${line.stage}`}>{STAGE_LABELS[line.stage]}</span>
              <span className="cad-detail">{line.detail}</span>
              <span className="cad-time">{timeOfDay(line.at)}</span>
            </div>
          ))}
        </div>
      )}

      {cad.running && (
        <div className="cad-running">
          <span className="cad-running-text">
            {activeStage ? `${STAGE_LABELS[activeStage]} in progress` : "starting"}
          </span>
          <button type="button" className="secondary-button cad-cancel" onClick={cancelTurn}>
            Cancel
          </button>
        </div>
      )}

      {!cad.running && !result && !cad.failure && cad.progress.length === 0 && (
        <div className="cad-idle">
          <p>
            Type an object name in the box below — <em>arduino uno</em>, <em>a standard wheel</em>,
            <em> a wristwatch</em>.
          </p>
          <ol>
            <li>
              Forge first searches for a real, downloadable STEP file (McMaster/TraceParts/manufacturer),
              and only accepts it after OpenCASCADE can read it.
            </li>
            <li>
              If no canonical file exists, the MAC sidecar generates one (Spec Planner → Geometric
              Architect → Python Coder → QA/repair loop) on the build123d kernel.
            </li>
            <li>
              Nothing is shown unless MAC's own QA diagnostics come back clean. A failed run is reported
              as a failure — never as a placeholder solid.
            </li>
          </ol>
          <p className="cad-hint">
            Generation requires the sidecar: <code>bash sidecars/start-mac.sh</code> (see
            <code> sidecars/README.md</code>). The search path works without it.
          </p>
        </div>
      )}

      {result && (
        <article className="cad-model">
          <div className="cad-model-head">
            <span className={`cad-badge ${result.source}`}>
              {result.source === "existing_model" ? "EXISTING MANUFACTURER FILE" : "GENERATED · QA VERIFIED"}
            </span>
            <button
              type="button"
              className="cad-ghost-button"
              onClick={() => setExpanded((value) => !value)}
              title={expanded ? "Shrink viewer" : "Expand viewer"}
            >
              {expanded ? "shrink" : "expand"}
            </button>
          </div>
          <model-viewer
            className={`cad-viewer ${expanded ? "expanded" : ""}`}
            src={artifactUrl(result.glbPath)}
            alt="Generated CAD model preview"
            camera-controls
            touch-action="none"
            auto-rotate
            auto-rotate-delay={1200}
            interaction-prompt="auto"
            shadow-intensity="0.6"
            exposure="0.9"
            loading="eager"
          />
          <div className="cad-viewer-hint">drag to orbit · scroll to zoom · right-drag to pan</div>
          <div className="cad-actions">
            <a className="primary-button cad-download" href={artifactUrl(result.stepPath, true)} download>
              Download STEP
            </a>
            <a className="secondary-button cad-download" href={artifactUrl(result.glbPath, true)} download>
              Download GLB
            </a>
            {result.stlPath && (
              <a className="secondary-button cad-download" href={artifactUrl(result.stlPath, true)} download>
                STL
              </a>
            )}
          </div>
          <ul className="cad-meta">
            {result.sourceUrl && (
              <li>
                source: <a href={result.sourceUrl} target="_blank" rel="noreferrer">{result.sourceUrl}</a>
              </li>
            )}
            <li>STEP: <code>{result.stepPath}</code></li>
            <li>preview: <code>{result.glbPath}</code></li>
          </ul>
        </article>
      )}

      {cad.failure && (
        <article className="cad-failure" role="alert">
          <header className="cad-failure-head">
            <span className="cad-failure-icon" aria-hidden="true">✕</span>
            <span className="cad-failure-title">No model — {STAGE_LABELS[cad.failure.stage]}</span>
          </header>
          <p className="cad-failure-reason">{cad.failure.reason}</p>
          <div className="cad-failure-actions">
            {!refining && (
              <button type="button" className="primary-button" onClick={startRefine}>
                Try again with more detail
              </button>
            )}
            <button type="button" className="secondary-button" onClick={clearCad}>Dismiss</button>
          </div>
          {refining && (
            <div className="cad-refine">
              <p className="cad-hint">
                Add the numbers a generator can't guess: overall size, hole/thread diameters, wall
                thickness, fillet/chamfer radii, how many repeating features, and whether bodies must move.
              </p>
              <textarea
                className="cad-refine-input"
                rows={5}
                value={refineText}
                onChange={(event) => setRefineText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    submitRefine();
                  }
                }}
              />
              <div className="cad-refine-actions">
                <span className="cad-hint">Nothing re-runs until you send this.</span>
                <button type="button" className="primary-button" onClick={submitRefine} disabled={!refineText.trim()}>
                  Regenerate
                </button>
              </div>
            </div>
          )}
        </article>
      )}
    </section>
  );
}
