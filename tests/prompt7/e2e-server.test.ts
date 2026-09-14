import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerMessage } from "@forge/shared";
import { startFakeMacSidecar } from "./fake-mac-sidecar";
import { inspectGlb } from "../../packages/server/src/cad/convertToGlb";

/**
 * Whole-stack test: a real `bun packages/server/src/server.ts` process, a real
 * WebSocket client, the real CAD pipeline, a real STEP fixture, and a real
 * HTTP artifact read back out of the CAD cache. Only the MAC sidecar itself is
 * faked (by `fake-mac-sidecar.ts`, which mirrors its routes exactly).
 *
 * It asserts the things that could only break in the seams:
 *   · `cad_generate` is accepted by the protocol and routed to the pipeline
 *     (not to the agent loop)
 *   · progress reaches the socket as `cad_progress` in order
 *   · the verified model lands in the cache and is served back byte-identically
 *   · nothing outside the cache is readable through that route
 */

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const PORT = Number(process.env.FORGE_PROMPT7_PORT ?? 4711);
const BASE = `http://127.0.0.1:${PORT}`;

let dir: string;
let child: ReturnType<typeof Bun.spawn> | null = null;
let sidecar: Awaited<ReturnType<typeof startFakeMacSidecar>> | null = null;
let skipped = false;
let usedRealKernel = false;

async function converterBin(): Promise<string> {
  const { resolveCascadeBin } = await import("../../packages/server/src/cad/convertToGlb");
  const real = await resolveCascadeBin(process.env.FORGE_CAD_OCCT_BIN ?? "opencascade-tools");
  if (real) {
    usedRealKernel = true;
    return real;
  }
  // No kernel CLI installed (CI without the optional global): stub the CLI
  // contract so the *wiring* is still exercised end to end.
  const script = join(dir, "occt-stub.mjs");
  await writeFile(script, [
    "import { writeFileSync } from 'node:fs';",
    "const src = process.argv.at(-1);",
    "const json = JSON.stringify({ asset: { version: '2.0' }, meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],",
    "  accessors: [{ count: 3, type: 'VEC3', componentType: 5126 }], bufferViews: [{ byteLength: 36 }], buffers: [{ byteLength: 36 }] });",
    "const chunk = json + ' '.repeat((4 - (json.length % 4)) % 4);",
    "const bin = Buffer.alloc(36);",
    "const out = Buffer.alloc(12);",
    "out.write('glTF', 0, 'latin1'); out.writeUInt32LE(2, 4);",
    "out.writeUInt32LE(12 + 8 + chunk.length + 8 + bin.length, 8);",
    "const jh = Buffer.alloc(8); jh.writeUInt32LE(chunk.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);",
    "const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);",
    "writeFileSync(src.replace(/\\.[^.]+$/, '') + '.glb', Buffer.concat([out, jh, Buffer.from(chunk, 'latin1'), bh, bin]));",
  ].join("\n"));
  const wrapper = join(dir, "occt-stub.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  const { chmod } = await import("node:fs/promises");
  await chmod(wrapper, 0o755);
  return wrapper;
}

beforeAll(async () => {
  dir = await mkdtemp("/tmp/forge-cad-e2e-");
  try {
    const probe = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
    // Something already owns the port (a dev server). Don't fight it.
    skipped = !probe.ok;
  } catch {
    skipped = false;
  }
  if (skipped) return;

  sidecar = await startFakeMacSidecar({
    files: { "model.step": await Bun.file(`${FIXTURES}flange.step`).text() },
  });

  child = Bun.spawn(["bun", "run", "packages/server/src/server.ts"], {
    cwd: join(import.meta.dir, "..", ".."),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(PORT),
      DATABASE_PATH: join(dir, "forge.sqlite"),
      ALLOWED_ORIGINS: "",
      FORGE_CAD_MAC_URL: sidecar.url,
      FORGE_CAD_ARTIFACT_DIR: join(dir, "cad"),
      FORGE_CAD_SEARCH: "false",
      FORGE_CAD_OCCT_BIN: await converterBin(),
      FORGE_CAD_BASE_URL: "http://127.0.0.1:11434/v1",
      FORGE_CAD_MODEL: "test-model",
      FORGE_CAD_API_KEY: "test-key",
      INDEX_ENABLED: "false",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(250) });
      if (health.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("agent server did not come up for the Prompt 7 e2e test");
}, 60_000);

afterAll(async () => {
  child?.kill();
  sidecar?.close();
});

test("a CAD request travels the real socket, produces a cached model, and is served back verbatim", async () => {
  if (skipped) {
    console.warn(`[prompt7] e2e skipped: something already listens on ${BASE} — stop it or set FORGE_PROMPT7_PORT`);
    return;
  }
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const messages: ServerMessage[] = [];
  const workspaceRoot = join(import.meta.dir, "..", "..");

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no session_ready")), 15_000);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String((event as MessageEvent).data)) as ServerMessage;
      messages.push(message);
      if (message.type === "session_ready") {
        clearTimeout(timer);
        resolve();
      }
      if (message.type === "cad_model_ready" || message.type === "cad_generation_failed") {
        clearTimeout(timer);
        resolve();
      }
    });
    socket.addEventListener("error", () => reject(new Error("socket error")));
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "init", workspaceRoot }));
      resolve();
    }, { once: true });
    setTimeout(() => reject(new Error("socket never opened")), 10_000);
  });
  await ready;

  socket.send(JSON.stringify({ type: "cad_generate", prompt: "a circular flange with a bore and four holes" }));

  // Wait for the terminal message.
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (messages.some((message) => message.type === "cad_model_ready" || message.type === "cad_generation_failed")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const failure = messages.find((message) => message.type === "cad_generation_failed") as
    | { type: "cad_generation_failed"; failure: { reason: string; stage: string } } | undefined;
  expect(failure).toBeUndefined();
  const readyMessage = messages.find((message) => message.type === "cad_model_ready") as
    | { type: "cad_model_ready"; result: { glbPath: string; stepPath: string; source: string } } | undefined;
  expect(readyMessage).toBeDefined();
  if (!readyMessage) return;

  expect(readyMessage.result.source).toBe("generated");
  expect(readyMessage.result.glbPath).toContain(join(dir, "cad"));

  // The stage log the UI renders is real, ordered, and names MAC's stages.
  const progress = messages.filter((message) => message.type === "cad_progress") as
    Extract<ServerMessage, { type: "cad_progress" }>[];
  const stages = progress.map((message) => message.event.stage);
  expect(stages).toEqual(expect.arrayContaining(["spec_planning", "architecting", "coding", "qa_pass", "converting"]));
  expect(stages.indexOf("spec_planning")).toBeLessThan(stages.indexOf("converting"));

  // The served bytes are the verified model: the STEP is the fixture exactly.
  const stepResponse = await fetch(`${BASE}/cad/artifact?path=${encodeURIComponent(readyMessage.result.stepPath)}`);
  expect(stepResponse.status).toBe(200);
  expect(stepResponse.headers.get("content-type")).toBe("application/step");
  expect(await stepResponse.text()).toBe(await Bun.file(`${FIXTURES}flange.step`).text());

  const glbResponse = await fetch(`${BASE}/cad/artifact?path=${encodeURIComponent(readyMessage.result.glbPath)}`);
  expect(glbResponse.status).toBe(200);
  const glbBytes = new Uint8Array(await glbResponse.arrayBuffer());
  await Bun.write(join(dir, "served.glb"), glbBytes);
  const scene = await inspectGlb(join(dir, "served.glb"));
  expect(scene.ok).toBe(true);
  expect(scene.primitives).toBeGreaterThan(0);
  if (usedRealKernel) {
    // With the real WASM kernel in the loop, the flange (bore + 4 holes) must
    // arrive as a genuine tessellated solid — not an empty scene and not a box.
    expect(scene.triangles).toBeGreaterThan(200);
    expect(scene.triangles).toBeLessThan(2_000_000);
  }

  // …and the same route refuses anything that is not in the cache.
  const escape = await fetch(`${BASE}/cad/artifact?path=${encodeURIComponent("/etc/passwd")}`);
  expect(escape.status).toBe(404);

  socket.close();
}, 90_000);

test("a dead sidecar reaches the client as a specific failure, not a spinner or a stub", async () => {
  if (skipped) return;
  const failDir = await mkdtemp("/tmp/forge-cad-e2e-fail-");
  const failPort = PORT + 1;
  const child = Bun.spawn(["bun", "run", "packages/server/src/server.ts"], {
    cwd: join(import.meta.dir, "..", ".."),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(failPort),
      DATABASE_PATH: join(failDir, "forge.sqlite"),
      FORGE_CAD_MAC_URL: "http://127.0.0.1:1",       // nothing listens there
      FORGE_CAD_ARTIFACT_DIR: join(failDir, "cad"),
      FORGE_CAD_SEARCH: "false",
      FORGE_CAD_BASE_URL: "http://127.0.0.1:11434/v1",
      FORGE_CAD_MODEL: "test-model",
      FORGE_CAD_API_KEY: "test-key",
      INDEX_ENABLED: "false",
    },
    stdout: "ignore", stderr: "ignore",
  });
  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const health = await fetch(`http://127.0.0.1:${failPort}/health`, { signal: AbortSignal.timeout(250) });
        if (health.ok) break;
      } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const socket = new WebSocket(`ws://127.0.0.1:${failPort}`);
    const seen: ServerMessage[] = [];
    socket.addEventListener("message", (event) => seen.push(JSON.parse(String((event as MessageEvent).data)) as ServerMessage));
    await new Promise<void>((resolve) => socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "init", workspaceRoot: join(import.meta.dir, "..", "..") }));
      resolve();
    }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    socket.send(JSON.stringify({ type: "cad_generate", prompt: "a wristwatch" }));
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (seen.some((message) => message.type === "cad_generation_failed" || message.type === "cad_model_ready")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(seen.some((message) => message.type === "cad_model_ready")).toBe(false);
    const failed = seen.find((message) => message.type === "cad_generation_failed") as
      | { type: "cad_generation_failed"; failure: { reason: string; stage: string } } | undefined;
    expect(failed).toBeDefined();
    expect(failed?.failure.reason).toContain("MAC sidecar is not reachable");
    expect(failed?.failure.reason).toContain("bash sidecars/start-mac.sh");
    expect(failed?.failure.stage).toBe("spec_planning");
    socket.close();
  } finally {
    child.kill();
  }
}, 60_000);
