import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CadProgressEvent, ServerMessage } from "@forge/shared";
import type { CadConfig } from "../../packages/server/src/cad/config";
import { MacClient } from "../../packages/server/src/cad/macClient";
import { runCadPipeline } from "../../packages/server/src/cad/pipeline";
import { startFakeMacSidecar, type FakeJobScript } from "./fake-mac-sidecar";

/**
 * End-to-end orchestration against a faithful fake sidecar and a real
 * OpenCASCADE STEP fixture: the search-first branch, the generate branch, and
 * — most importantly — the two branches where Forge must refuse rather than
 * improvise.
 */

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

async function stubConverter(dir: string): Promise<string> {
  const script = join(dir, "occt-stub.mjs");
  await writeFile(script, [
    "import { writeFileSync } from 'node:fs';",
    "const src = process.argv.at(-1);",
    "const json = JSON.stringify({ asset: { version: '2.0' }, meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],",
    "  accessors: [{ count: 3, type: 'VEC3', componentType: 5126 }], bufferViews: [{ byteLength: 36 }], buffers: [{ byteLength: 36 }] });",
    "const jsonChunk = json + ' '.repeat((4 - (json.length % 4)) % 4);",
    "const bin = Buffer.alloc(36);",
    "const out = Buffer.alloc(12);",
    "out.write('glTF', 0, 'latin1'); out.writeUInt32LE(2, 4);",
    "out.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8);",
    "const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonChunk.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);",
    "const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);",
    "writeFileSync(src.replace(/\\.[^.]+$/, '') + '.glb', Buffer.concat([out, jh, Buffer.from(jsonChunk, 'latin1'), bh, bin]));",
  ].join("\n"));
  const wrapper = join(dir, "occt-stub.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  const { chmod } = await import("node:fs/promises");
  await chmod(wrapper, 0o755);
  return wrapper;
}

async function setup(script: FakeJobScript = {}, overrides: Partial<CadConfig> = {}): Promise<{
  config: CadConfig; dir: string; sidecar: Awaited<ReturnType<typeof startFakeMacSidecar>>; client: MacClient;
  messages: ServerMessage[]; emit: (message: ServerMessage) => void;
}> {
  const dir = await mkdtemp("/tmp/forge-cad-pipeline-");
  const sidecar = await startFakeMacSidecar(script);
  const config = {
    enabled: true,
    macBaseUrl: sidecar.url,
    requestTimeoutMs: 5_000,
    jobTimeoutMs: 20_000,
    pollIntervalMs: 20,
    attemptBudget: 3,
    artifactDir: dir,
    searchEnabled: false,
    searchMaxResults: 8,
    maxDownloadBytes: 2_000_000,
    downloadTimeoutMs: 5_000,
    cascadeBin: await stubConverter(dir),
    cascadeTimeoutMs: 5_000,
    cascadeLinDeflection: 0.25,
    cascadeAngDeflection: 0.35,
    rejectTrivialPrimitive: true,
    llm: { baseUrl: "http://x/v1", model: "m", aiderModel: "openai/m", apiKey: "k", provider: "test" },
    ...overrides,
  } as CadConfig;
  // Make MAC hand back the real fixture so the gate's STEP validation is real too.
  const messages: ServerMessage[] = [];
  return {
    config, dir, sidecar,
    client: new MacClient(config),
    messages,
    emit: (message) => messages.push(message),
  };
}

/** Point the fake sidecar at the real STEP bytes for this test run. */
const fixtureFiles = async (): Promise<Record<string, string>> => ({
  "model.step": await Bun.file(`${FIXTURES}flange.step`).text(),
});

const events = (messages: ServerMessage[]): CadProgressEvent[] =>
  messages.filter((message): message is { type: "cad_progress"; event: CadProgressEvent } => message.type === "cad_progress")
    .map((message) => message.event);

test("search off → MAC path → gate passes → one conversion → cad_model_ready", async () => {
  const context = await setup({ files: await fixtureFiles() });
  const outcome = await runCadPipeline({
    prompt: "a circular flange with a 30 mm bore and 4 bolt holes",
    config: context.config, emit: context.emit, client: context.client, requestId: "job-ok",
  });
  context.sidecar.close();

  expect(outcome.result).toBeDefined();
  expect(outcome.failure).toBeUndefined();
  expect(outcome.result?.source).toBe("generated");
  expect(outcome.result?.stepPath).toBe(join(context.dir, "job-ok", "model.step"));
  expect(outcome.result?.glbPath).toBe(join(context.dir, "job-ok", "model.glb"));
  expect(await Bun.file(outcome.result!.glbPath).exists()).toBe(true);
  // The result must be the *fixture*, byte for byte — proof the pipeline handed
  // back the real model rather than a synthesised stand-in.
  expect(await Bun.file(outcome.result!.stepPath).text()).toBe(await Bun.file(`${FIXTURES}flange.step`).text());

  const stages = events(context.messages).map((event) => event.stage);
  expect(stages).toContain("spec_planning");
  expect(stages).toContain("architecting");
  expect(stages).toContain("coding");
  expect(stages).toContain("qa_pass");
  expect(stages).toContain("converting");
  expect(context.messages.at(-1)?.type).toBe("cad_model_ready");
  expect(context.sidecar.runs).toHaveLength(1);
});

test("an unresolved QA entry is a hard stop: no model, best-of-N included", async () => {
  const context = await setup({
    files: { ...(await fixtureFiles()), "missed.json": JSON.stringify([
      "FILLET_FAILED: hub — all radii [2, 1.5, 1] failed (Stage 1 + Stage 2). Last: no edges matched filter",
      "FILLET_FAILED: rim — no edges matched filter",
    ]) },
    done: { error_type: "dimension", missed: "/tmp/x/temp_missed_2.json" },
  });
  const outcome = await runCadPipeline({
    prompt: "a flange with 2 mm fillets on the hub and rim",
    config: context.config, emit: context.emit, client: context.client, requestId: "job-qa-fail",
  });
  context.sidecar.close();

  expect(outcome.result).toBeUndefined();
  expect(outcome.failure).toBeDefined();
  expect(outcome.failure?.stage).toBe("qa_pass");
  expect(outcome.failure?.reason).toContain("FILLET_FAILED on 2 fillet edge group(s)");
  expect(outcome.failure?.reason).toContain("after 3 QA attempts");
  expect(context.messages.at(-1)?.type).toBe("cad_generation_failed");
  // A QA verdict is terminal: exactly one job was ever started, and Forge never
  // quietly keeps the "best" failed attempt.
  expect(context.sidecar.runs).toHaveLength(1);
});

test("a bare primitive standing in for a featureful request is refused", async () => {
  const context = await setup({
    files: { "model.step": await Bun.file(`${FIXTURES}plate.step`).text() },
  });
  const outcome = await runCadPipeline({
    prompt: "an L-bracket with four 6 mm holes and 3 mm fillets on the outer edges",
    config: context.config, emit: context.emit, client: context.client, requestId: "job-box",
  });
  context.sidecar.close();
  expect(outcome.result).toBeUndefined();
  expect(outcome.failure?.reason).toContain("single bare primitive");
});

test("an unreachable sidecar reports the exact fix, and starts nothing", async () => {
  const context = await setup();
  context.sidecar.close();
  const outcome = await runCadPipeline({
    prompt: "a wristwatch",
    config: { ...context.config, macBaseUrl: "http://127.0.0.1:1" },
    emit: context.emit,
    client: new MacClient({ ...context.config, macBaseUrl: "http://127.0.0.1:1" }),
    requestId: "job-offline",
  });
  expect(outcome.result).toBeUndefined();
  expect(outcome.failure?.reason).toContain("MAC sidecar is not reachable at http://127.0.0.1:1");
  expect(outcome.failure?.reason).toContain("bash sidecars/start-mac.sh");
  expect(context.messages.at(-1)?.type).toBe("cad_generation_failed");
});

test("no STEP on disk means no viewer: conversion failure is a specific failure", async () => {
  const context = await setup({ files: { "model.step": "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\n" } });
  const outcome = await runCadPipeline({
    prompt: "a small flange with a bore and holes",
    config: context.config, emit: context.emit, client: context.client, requestId: "job-broken",
  });
  context.sidecar.close();
  expect(outcome.result).toBeUndefined();
  // The gate re-reads the bytes it downloaded, so a model that did not survive
  // the transfer never reaches the viewer — with the actual reason named.
  expect(outcome.failure?.reason).toContain("failed STEP validation");
  expect(outcome.failure?.stage).toBe("converting");
});

test("the conversion tool being absent is reported as a setup problem, not a silent skip", async () => {
  const context = await setup({ files: await fixtureFiles() }, { cascadeBin: "/nonexistent/opencascade-tools" });
  const outcome = await runCadPipeline({
    prompt: "a flange with a bore, 80 mm OD and four holes",
    config: context.config, emit: context.emit, client: context.client, requestId: "job-notool",
  });
  context.sidecar.close();
  expect(outcome.result).toBeUndefined();
  expect(outcome.failure?.stage).toBe("converting");
  expect(outcome.failure?.reason).toContain("npm install -g opencascade-tools");
});

test("a cancelled pipeline emits a failure, never a stale model", async () => {
  const context = await setup({ holdMs: 300, files: await fixtureFiles() });
  const controller = new AbortController();
  const running = runCadPipeline({
    prompt: "a big articulated assembly with 6 holes and fillets",
    config: context.config, emit: context.emit, client: context.client,
    signal: controller.signal, requestId: "job-cancel",
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  controller.abort(new Error("user cancelled"));
  const outcome = await running;
  context.sidecar.close();
  expect(outcome.cancelled).toBe(true);
  expect(outcome.result).toBeUndefined();
  expect(outcome.failure?.reason).toContain("Cancelled");
});

test("the search-first result short-circuits MAC entirely", async () => {
  const context = await setup({}, { searchEnabled: true });
  const flange = await Bun.file(`${FIXTURES}flange.step`).text();
  // A local host that serves the file the "search" points at.
  const fileHost = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(flange, { headers: { "content-type": "application/step" } }),
  });
  void fileHost.url;
  const outcome = await runCadPipeline({
    prompt: "a standard M8 hex bolt",
    config: context.config,
    emit: context.emit,
    client: context.client,
    requestId: "job-search",
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) =>
      fileHost.fetch(new Request(String(input), init as RequestInit))) as typeof fetch,
    searchImpl: async (query) => ({
      provider: "tavily", query,
      results: [{ title: "M8 hex bolt — CAD", url: `${fileHost.url}/m8-hex-bolt.step`, snippet: "direct STEP download" }],
    }),
  });
  fileHost.stop(true);
  context.sidecar.close();

  expect(outcome.result?.source).toBe("existing_model");
  expect(outcome.result?.sourceUrl).toContain("m8-hex-bolt.step");
  expect(context.sidecar.runs).toHaveLength(0);      // MAC was never asked
  expect(events(context.messages)[0]!.stage).toBe("searching_existing");
});
