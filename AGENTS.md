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
- `bun test` (root) — whole-repo test suite (118 pass / 17 pre-existing fail / 1 error is baseline)
  - includes `packages/wireup/test/smoke.test.ts` (5) + `packages/server/src/wireup/store.test.ts` (1)
- `bun run --cwd packages/server typecheck`
- `bun run typecheck` — client typecheck (root script)
- Baseline server typecheck errors that are pre-existing and NOT mine:
  1. `packages/server/src/db/client.ts:90` (DiffProposal status typing)
  2. `packages/server/src/providers/aws/eventStream.ts:120` (Uint8Array<ArrayBufferLike>)

## Known state
- Played baseline: `bun test` = 118 pass / 17 fail / 1 error (git/electron/zustand
  harness failures, unrelated to provider work). The +6 passers over the old 112
  are the wireup engine smoke tests + the hardware_build↔SQLite integration test.
- The engine (`@forge/wireup`) is PORted and standalone-green: typecheck + tests
  pass. It is wired into the server as the `hardware_build` agent tool, with an
  SQLite persistence sink (`packages/server/src/wireup/store.ts`) seeded into
  `schema.sql` (now `schema_version` 3) and hydrated at boot (`server.ts`).
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