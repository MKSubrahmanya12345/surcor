# CAD sidecar — MAC (Multi-Agent CAD)

Forge's **CAD mode** does not invent geometry on its own. It asks
[MAC](https://github.com/Pan-Chera/Multi-Agent-CAD) (Tsinghua IEI Lab, MIT) to
write `build123d` code against OpenCASCADE, run it, QA it, and repair it — then
Forge reads MAC's own verdict and refuses to show anything that did not pass.

MAC is an **optional local service**, set up once by you and started like Ollama
is. It is deliberately *not* bundled or auto-installed by the Electron installer:
it needs a real Python environment and its own LLM key, and it executes
LLM-generated Python, which is not something a code editor should silently do for
you.

```
forge (bun, packages/server/src/cad/)  ──HTTP──▶  MAC web service (python, :8000)
        search-first  ──found──▶  OpenCASCADE STEP→GLB   │
        └─ not found ─▶ Spec Planner → Architect → Coder │→ QA/repair loop
                               └── temp_missed_N.json ◀───┘  (Forge reads this)
```

## One-time setup

`bash sidecars/setup-mac.sh` does all of this; the steps are listed so nothing is
hidden. This directory is git-ignored (`sidecars/multi-agent-cad/`) — the only
things in it that belong to Forge are the two scripts and this file.

1. **Clone** the upstream repo here:

   ```bash
   git clone https://github.com/Pan-Chera/Multi-Agent-CAD sidecars/multi-agent-cad
   ```

2. **Install it exactly as its own README says** — not from memory. Recommended
   path is conda:

   ```bash
   cd sidecars/multi-agent-cad
   conda env create -f environment.yml
   conda activate multi_agent_cad
   pip install --no-deps "aider-chat==0.82.3"
   ```

   The last line is not optional and not an improvisation: every `aider-chat`
   release pins `numpy==1.26.4` while `build123d` needs `numpy>=2`, so MAC ships
   aider outside `environment.yml` and installs it with `--no-deps`. Without
   conda, MAC's README documents a pure-pip fallback (venv on Python 3.11,
   install aider first, then `pip install --no-deps --force-reinstall
   "numpy>=2,<2.3"`, then the rest, then `pip install --no-deps -e .`) —
   `setup-mac.sh` follows that recipe verbatim.

3. **Give the pipeline an LLM.** MAC talks to any OpenAI-compatible endpoint.
   Either edit `multi_agent_cad/config.py` (`DS_BASE_URL`, the four `*_MODEL`
   fields, and `*_KWARGS = {}` for non-Qwen providers) — or, preferably, change
   nothing: **Forge sends a complete per-job config** built from its own provider
   router (Prompt 3), which the sidecar applies through its documented
   `MAC_CONFIG_FILE` override mechanism. The key is always read from
   `DASHSCOPE_API_KEY`, whatever provider it belongs to; Forge passes it in the
   `POST /api/run` body, which the sidecar forwards to the runner as
   `DASHSCOPE_API_KEY`.

   ```bash
   export DASHSCOPE_API_KEY=sk-...     # only needed to run MAC's own UI/CLI
   ```

4. **Install the web extras and start the service:**

   ```bash
   pip install -e ".[web]"
   bash sidecars/start-mac.sh          # python -m multi_agent_cad.web
   ```

   `start-mac.sh` pins `MAC_WEB_HOST=127.0.0.1`. MAC's own default is `0.0.0.0`,
   and since the service executes generated Python server-side (single-user,
   trusted-network by design), loopback is the right default for a laptop.

5. **Point Forge at it** in `packages/server/.env`:

   ```ini
   FORGE_CAD_MAC_URL=http://127.0.0.1:8000
   FORGE_CAD_MODEL=qwen3-coder:32b          # anything served at FORGE_CAD_BASE_URL
   #FORGE_CAD_BASE_URL=http://localhost:11434/v1   # Ollama: free, no key
   ```

   With none of the `FORGE_CAD_*` variables set, Forge reuses the first
   OpenAI-compatible provider in `PROVIDER_ORDER` (openai → gemini → ollama).

6. **The STEP→GLB converter** the in-app viewer needs:

   ```bash
   npm install -g opencascade-tools     # or FORGE_CAD_OCCT_BIN=/path/to/the/bin
   ```

   It is OpenCascade compiled to WebAssembly — the same kernel family FreeCAD
   uses — and it is what Forge uses to *verify* a downloaded manufacturer file,
   not just to render it.

## The HTTP interface Forge actually speaks

MAC's README confirms a FastAPI web service exists but does not document its
routes, so these were read out of the source — `multi_agent_cad/web/server.py`
(note: **`web/server.py`**, there is no `web.py`) and `web_runner.py`.
`macClient.ts` implements exactly this, and `packages/server/src/cad/macClient.ts`
carries the same table in its header comment.

| Route | Purpose |
|---|---|
| `POST /api/run` | `{prompt, config, workflow, api_key}` → `{job_id}`; **400** if `prompt` or `api_key` is empty. `config` is written to a per-job `config.json` and applied via `MAC_CONFIG_FILE`. |
| `GET /api/jobs/{id}/events` | SSE of the runner's NDJSON: `{stage, log, iter}` per graph node (`planner`, `architect`, `coder`, `autonomous_skill_loop`), `{intermediate, glb}` when a live preview is republished, `{error, traceback}` on a crash, and the terminal `{done, error_type, step, stl, glb, py, measurements, missed, tokens, api_calls}`. |
| `GET /api/jobs/{id}/result` | the same terminal record, or `{"status":"running"}` — the fallback if the SSE stream drops. |
| `GET /api/jobs/{id}/files/{name}` | `model.step`, `model.stl`, `model.glb`, `source.py`, `measurements.json`, `missed.json`, `live.glb`; **404** until that artifact exists. |
| `POST /api/jobs/{id}/cancel` | SIGTERM (then SIGKILL) the runner; partial artifacts stay downloadable. |
| `GET /api/health` | `{"status":"ok"}` — Forge checks this before submitting, and names the fix if it does not answer. |
| `GET /api/config/schema` | the editable config fields with their current defaults. |

Output artifacts are written per job into a tempdir the runner chdirs into, so
`temp_output_N.step`, `temp_output_N.stl`, `temp_design_N.py`,
`temp_measurements_N.json` and `temp_missed_N.json` never collide between runs.
`temp_missed_N.json` is the file Forge's quality gate is built around: a plain
array of strings, each prefixed with MAC's own diagnostic label — `MISSED_CUT`,
`CUT_ERROR`, `FILLET_FAILED`, `CHAMFER_FAILED`, plus the non-blocking
`*_DEGRADED` / `*_PARTIAL` variants. MAC writes it only when something went
wrong, so *absent* means clean, and Forge treats it that way.

## What Forge does with it

| Concern | Where |
|---|---|
| Search for a real, downloadable STEP first (McMaster/Traceparts/manufacturer), validated by magic bytes + STEP structure + a real OpenCASCADE read | `packages/server/src/cad/searchExisting.ts` |
| Submit → watch stages → fetch model **and** diagnostics | `packages/server/src/cad/macClient.ts` |
| Pass/fail on MAC's own QA verdict, attempt budget, hard stop | `packages/server/src/cad/qualityGate.ts` |
| The single STEP→GLB path both branches share | `packages/server/src/cad/convertToGlb.ts` |
| Orchestration + `cad_progress` / `cad_model_ready` / `cad_generation_failed` | `packages/server/src/cad/pipeline.ts` |
| Serving verified artifacts to the viewer (`GET /cad/artifact`) | `packages/server/src/cad/artifacts.ts` |

Forge's retry budget *is* MAC's iteration loop: `attemptBudget` (default 3) is
sent as `MAX_RETRIES`, so a failed QA pass takes MAC's 10-second iteration
checkpoint and auto-iterates through Aider repair, rather than Forge restarting
the Spec Planner. When the budget is exhausted with no clean pass, the answer is
a failure card that quotes the diagnostics — never the "best" failed attempt and
never a placeholder solid.

## Verification without a GPU, a key, or a network

```bash
bun test tests/prompt7            # the whole Prompt 7 suite
```

`tests/prompt7/fake-mac-sidecar.ts` mirrors the route table above, and
`tests/prompt7/fixtures/*.step` were exported by a real OpenCASCADE kernel, so
the pipeline, gate, protocol, DB migration and artifact route are all exercised
for real. `tests/prompt7/opencascade.test.ts` and the e2e test additionally run
the actual `opencascade-tools` CLI when it is installed, and say so loudly when
it is not.
