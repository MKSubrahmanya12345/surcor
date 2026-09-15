# AGENTS.md — Forge (surcor) working agreement

## Objective
Transform Forge (a Cursor-clone IDE, Bun monorepo) into an IDE shell for agentic
hardware engineering by porting Wireup's agent engine (`E:\PES\wireup-mvp`) into
this monorepo as the workspace package **`@forge/wireup`** — no Next.js, no
MongoDB. Architecture of surcor wins: the engine becomes a Bun library backed by
Forge's SQLite, surfaced through Forge's agent tools and WebSocket protocol.

## User decisions (recorded)
- Agent runs autonomously (user asleep, all permissions granted).
- Wireup features move INTO Forge; Forge's UI/flow stays fixed. No Next.js.
- Feedback loops from BOTH real hardware and the Velxio simulator.
- Cross-project memory: yes.
- LLM defines "done" (authors goals/acceptance); **code judges** evaluate against
  evidence — never model opinion.
- Broken bench/safety model: no approval prompts; pin-config sanity, current
  caps, failed flash quarantines the board; action chains are recorded.

## Port strategy
- `packages/wireup/src/{modules,lib,types}` copied verbatim from wireup's `src`,
  keeping the `@/` alias (tsconfig `paths: { "@/*": ["./src/*"] }`).
- Exclusions: `app/**`, `components/**`, `models/**`, `lib/http.ts`,
  `modules/software-generator/**` (bootstrap the React web-dashboard with its
  real import `from 'react'`), and `modules/simulation/**` except
  `headless-avr/**` + `velxio-key.ts` (the two files the core pipeline needs).
- `lib/mongodb/{projects,components,client}.ts` are REPLACED by memory-backed
  implementations that keep the exact exported signatures, flushing through a
  pluggable persistence sink (Forge's SQLite) so project state survives restarts.
- Deps for the engine: `zod@^3` (Bun nests it; server/shared stay on zod v4),
  `@aws-sdk/client-bedrock-runtime`, `avr8js`.

## Non-negotiables
- Preserve the uncommitted provider-removal work (bedrock-only) in the working tree.
- `.env` contains real AWS secrets (gitignored): never log or copy them.
- Never commit unless explicitly asked.
- engine is deterministic-first: every stage degrades honestly to the catalog
  when Bedrock is unavailable (this is the offline-complete promise).

## Verify commands
- `bun install` (root, after editing package.jsons)
- `bun run --cwd packages/wireup typecheck` — engine typecheck
- `bun test` (root) — whole-repo test suite (169 pass / 18 pre-existing fail / 0 error is baseline)
  - includes `packages/wireup/test/smoke.test.ts` (5) + `packages/server/src/wireup/store.test.ts` (1) + all 80 Prompt-7 CAD tests
- `bun run --cwd packages/server typecheck`
- `bun run typecheck` — client typecheck (root script)
- Baseline server typecheck errors that are pre-existing and NOT mine:
  1. `packages/server/src/db/client.ts:125` (DiffProposal status typing)
  2. `packages/server/src/providers/aws/eventStream.ts:120` (Uint8Array<ArrayBufferLike>)

## Known state
- Current baseline after the `git pull` repair + CAD-on-Windows port: `bun test` =
  169 pass / 18 fail / 0 error. All 18 are pre-existing Windows harness failures
  unrelated to our work: prompt2/git+github+pty-missing+terminal `Cannot find
  module '@forge/shared'`, prompt5 `state().openFile`/`collapseAll`/`setState`
  zustand faults. Zero CAD, wireup, or hardware failures; no test errors.
- The engine (`@forge/wireup`) is PORted and standalone-green: typecheck + tests
  pass. It is wired into the server as the `hardware_build` agent tool, with an
  SQLite persistence sink (`packages/server/src/wireup/store.ts`) seeded into
  `schema.sql` (now `schema_version` 3) and hydrated at boot (`server.ts`).
- Upstream's Prompt-7 CAD suite (PR#8 merge) is now GREEN on Windows. Ported
  upstream POSIX-isms: `tests/prompt7/fixture.ts` (`fixturePath()` — never
  `new URL(...).pathname`, which yields `/E:/` on Windows); real `tmpdir()`
  instead of `mkdtemp("/tmp/...")` (Bun returns a drive-less `/tmp/x` path that
  Bun.spawn cannot execute); Windows stub converters write `occt-stub.cmd`
  (`@ECHO OFF` + `"%(bun)" "%~dp0occt-stub.mjs" %*`) instead of `#!/bin/sh`.
- CAD runtime fixes for Windows: `cad/artifacts.ts` containment is separator-aware
  (`contains()` + `basename()`), `cad/convertToGlb.ts` `resolveCascadeBin` searches
  `.exe/.cmd/.bat` variants (Bun's `.bin` shims are `.exe` on Windows, npm's are
  `.cmd`), splits PATH on `path.delimiter`, and falls back to `USERPROFILE`/
  `os.homedir()` for the global npm bin. `cad/config.ts` `resolveCadLlm` was
  rewritten for the bedrock-only world (env-derived OpenAI/Gemini/Ollama endpoints,
  provider order falls back to `["bedrock"]`).
- `opencascade-tools@^0.0.9` is now a root devDependency (WASM kernel), so the
  kernel test runs for real and CAD STEP→GLB conversion works on Windows; without
  it the suite degrades to the sidecar-GLB fallback + loud skip as designed.
- avr8js resolution foot-gun: `src/types/avr8js.d.ts` was a stale hand-rolled
  ambient shim that shadowed the real (installed, accurate) avr8js 0.21.1 typings
  and made TS report nonexistent "missing" exports. DELETED; the harness now
  typechecks against the real package. Do not reintroduce an ambient `declare
  module 'avr8js'`.
- Cross-package typecheck: server tsconfig maps `@/* → ../wireup/src/*` (TS7 has
  no baseUrl; paths are relative to the tsconfig) so the server program can
  compile wireup source imported via `@forge/wireup` (which resolves through
  wireup's `main`/`exports` → `./src/index.ts`).
- Server boot re-applies the merged `.env`+`process.env` map back onto
  `process.env` so the engine (which reads process.env directly) sees the same
  AWS keys/feature flags as the rest of the server.
- `sidecars/` is an untracked nested-repo artifact from git stash operations — leave alone.