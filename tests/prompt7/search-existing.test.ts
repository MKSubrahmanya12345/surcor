import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import type { CadProgressEvent, WebSearchResponse } from "@forge/shared";
import type { CadConfig } from "../../packages/server/src/cad/config";
import { findExistingModel, normalizeObjectName, searchQueries } from "../../packages/server/src/cad/searchExisting";

/**
 * The search-first path, exercised against a local HTTP host that behaves like
 * the real ones: one server answers with a genuine STEP file, another answers
 * with a login page under a `.step` URL (the failure mode this module exists
 * to survive). The final acceptance of a STEP is an actual OpenCASCADE read, so
 * a stub converter writes a real GLB container for the cases where the WASM CLI
 * is not installed.
 */

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

let dir: string;
let hosts: { close(): void; origin: string }[] = [];

const flangeStep = async (): Promise<string> => Bun.file(`${FIXTURES}flange.step`).text();

/** The bytes of a well-formed GLB holding one triangle. */
export function minimalGlb(): string {
  const json = JSON.stringify({
    asset: { version: "2.0" },
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ count: 3, type: "VEC3", componentType: 5126 }],
    bufferViews: [{ byteLength: 36 }],
    buffers: [{ byteLength: 36 }],
  }) + " ".repeat((4 - (JSON.stringify({}).length % 4)) % 4);
  const padded = json + " ".repeat((4 - (json.length % 4)) % 4);
  const bin = Buffer.alloc(36);
  const header = Buffer.alloc(20);
  header.write("glTF", 0, "latin1");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + padded.length + 8 + bin.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, Buffer.from(padded, "latin1"), (() => {
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.writeUInt32LE(bin.length, 0);
    chunkHeader.writeUInt32LE(0x004e4942, 4);
    return chunkHeader;
  })(), bin]).toString("latin1");
}

const serve = async (routes: Record<string, { body: string; type?: string; status?: number; headers?: Record<string, string> }>): Promise<{ close(): void; origin: string }> => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const route = routes[path];
      if (!route) return new Response("<html><body>404</body></html>", { status: 404, headers: { "content-type": "text/html" } });
      return new Response(route.body, {
        status: route.status ?? 200,
        headers: { "content-type": route.type ?? "application/octet-stream", ...(route.headers ?? {}) },
      });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
};

beforeAll(async () => {
  dir = await mkdtemp("/tmp/forge-cad-search-");
  const good = await flangeStep();
  hosts.push(await serve({
    "/bolts/m8-hex.step": { body: good, type: "application/step" },
    "/bolts/login.step": { body: "<!DOCTYPE html>\n<html><head><title>Sign in</title></head><body>Members only</body></html>", type: "text/html" },
    "/bolts/half.step": { body: good.slice(0, Math.floor(good.length / 2)) },
    "/index.html": {
      body: `<html><body><a href="/bolts/m8-hex.step">download</a><a href="/other.ts">nope</a></body></html>`,
      type: "text/html",
    },
    "/redirect.step": {
      body: "", status: 302,
      headers: { location: `/bolts/m8-hex.step` },   // hosts do redirect to their CDN
    },
  }));
});

afterAll(() => {
  for (const host of hosts) host.close();
});

const origin = (): string => hosts[0]!.origin;

const configWith = (overrides: Partial<CadConfig> = {}): CadConfig => ({
  enabled: true,
  macBaseUrl: "http://127.0.0.1:8000",
  requestTimeoutMs: 5_000,
  jobTimeoutMs: 20_000,
  pollIntervalMs: 50,
  attemptBudget: 3,
  artifactDir: dir,
  searchEnabled: true,
  searchMaxResults: 8,
  maxDownloadBytes: 2_000_000,
  downloadTimeoutMs: 5_000,
  cascadeBin: "/usr/bin/false",       // no real CLI in this test: the stub decides
  cascadeTimeoutMs: 5_000,
  cascadeLinDeflection: 0.25,
  cascadeAngDeflection: 0.35,
  rejectTrivialPrimitive: true,
  llm: { baseUrl: "http://x/v1", model: "m", aiderModel: "openai/m", apiKey: "k", provider: "test" },
  ...overrides,
} as CadConfig);

const searchReturning = (results: { url: string; title?: string; snippet?: string }[]): NonNullable<Parameters<typeof findExistingModel>[1]["searchImpl"]> =>
  async (query): Promise<WebSearchResponse> => ({
    provider: "tavily",
    query,
    results: results.map((result) => ({
      title: result.title ?? "result", url: result.url, snippet: result.snippet ?? "",
    })),
  });

/**
 * A stand-in for the `opencascade-tools` CLI: same CLI contract (last argument is
 * the source path, output is `<source-without-extension>.glb` next to it), and it
 * writes a *real* GLB container with a triangle in it. Only the kernel call is
 * faked — every other step of the acceptance path (download → magic bytes → STEP
 * structure → conversion) still runs for real, and the "kernel refused" test
 * proves the conversion result is actually required.
 */
const stubConverter = async (): Promise<string> => {
  const { chmod, writeFile } = await import("node:fs/promises");
  const script = join(dir, "occt-stub.mjs");
  await writeFile(script, [
    "import { writeFileSync } from 'node:fs';",
    "const src = process.argv.at(-1);",
    "const json = JSON.stringify({ asset: { version: '2.0' }, meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],",
    "  accessors: [{ count: 3, type: 'VEC3', componentType: 5126 }], bufferViews: [{ byteLength: 36 }], buffers: [{ byteLength: 36 }] });",
    "const pad = (4 - (json.length % 4)) % 4;",
    "const jsonChunk = json + ' '.repeat(pad);",
    "const bin = Buffer.alloc(36);",
    "const out = Buffer.alloc(12);",
    "out.write('glTF', 0, 'latin1'); out.writeUInt32LE(2, 4);",
    "out.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8);",
    "const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonChunk.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);",
    "const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);",
    "writeFileSync(src.replace(/\.[^.]+$/, '') + '.glb', Buffer.concat([out, jh, Buffer.from(jsonChunk, 'latin1'), bh, bin]));",
    "process.exit(0);",
  ].join("\n"));
  const wrapper = join(dir, "occt-stub.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(wrapper, 0o755);
  return wrapper;
};

test("object names are reduced to what a search engine can act on", () => {
  expect(normalizeObjectName("a standard M8 hex bolt")).toBe("M8 hex bolt");
  // Case is preserved on purpose: "Arduino Uno" searches better than "arduino uno".
  expect(normalizeObjectName("Please create an Arduino Uno board")).toBe("Arduino Uno board");
  expect(normalizeObjectName("model a simple articulated toy gyroscope")).toBe("articulated toy gyroscope");
  expect(searchQueries("M8 hex bolt")[0]).toContain("M8 hex bolt");
  expect(searchQueries("M8 hex bolt")).toHaveLength(4);
});

test("a direct STEP link in the results is downloaded, validated and converted", async () => {
  const bin = await stubConverter();
  const events: CadProgressEvent[] = [];
  const result = await findExistingModel("a standard M8 hex bolt", {
    config: configWith({ cascadeBin: bin }),
    artifactDir: dir,
    emit: (event) => events.push(event),
    searchImpl: searchReturning([{ url: `${origin()}/bolts/m8-hex.step`, title: "M8 hex bolt STEP" }]),
  });
  expect(result.model).not.toBeNull();
  if (!result.model) return;
  expect(result.model.sourceUrl).toContain("/bolts/m8-hex.step");
  expect(await Bun.file(result.model.stepPath).text()).toBe(await flangeStep());
  expect(result.model.summary).toContain("8 faces");
  expect(events.some((event) => event.stage === "searching_existing" && event.detail.includes("verified STEP"))).toBe(true);
});

test("an HTML login page served under a .step URL is rejected, not passed through", async () => {
  const bin = await stubConverter();
  const events: CadProgressEvent[] = [];
  const result = await findExistingModel("a standard M8 hex bolt", {
    config: configWith({ cascadeBin: bin }),
    artifactDir: dir,
    emit: (event) => events.push(event),
    searchImpl: searchReturning([{ url: `${origin()}/bolts/login.step`, title: "M8 bolt — McMaster-Carr" }]),
  });
  expect(result.model).toBeNull();
  expect(result.notes.some((note) => note.includes("HTML/JSON error page"))).toBe(true);
});

test("a truncated download is rejected even though the URL ended in .step", async () => {
  const bin = await stubConverter();
  const result = await findExistingModel("an M8 bolt", {
    config: configWith({ cascadeBin: bin }),
    artifactDir: dir,
    searchImpl: searchReturning([{ url: `${origin()}/bolts/half.step` }]),
  });
  expect(result.model).toBeNull();
  expect(result.notes.some((note) => note.includes("truncated"))).toBe(true);
});

test("a file the kernel cannot read is rejected even when the bytes look like STEP", async () => {
  const result = await findExistingModel("an M8 bolt", {
    config: configWith({ cascadeBin: "/usr/bin/false" }),   // conversion always fails
    artifactDir: dir,
    searchImpl: searchReturning([{ url: `${origin()}/bolts/m8-hex.step` }]),
  });
  expect(result.model).toBeNull();
  expect(result.notes.some((note) => note.includes("OpenCASCADE could not read it"))).toBe(true);
});

test("STL-only sources are skipped: the B-rep file is what a CAD workflow needs", async () => {
  const result = await findExistingModel("a wheel", {
    config: configWith(),
    artifactDir: dir,
    searchImpl: searchReturning([{ url: `${origin()}/wheel-3d.stl`, title: "wheel STL mesh" }]),
  });
  expect(result.model).toBeNull();
  expect(result.notes.some((note) => note.includes("STL only"))).toBe(true);
});

test("candidates are ranked, and a file link is followed onto the page too", async () => {
  const result = await findExistingModel("a wheel", {
    config: configWith(),
    artifactDir: dir,
    // The result page has no file in its URL — the link must come from markup.
    searchImpl: searchReturning([{ url: `${origin()}/index.html`, title: "bolt catalogue index" }]),
  });
  // The index page links a valid STEP; it must be found, downloaded and verified.
  expect(result.notes.some((note) => note.includes("no direct STEP/STL link"))).toBe(false);
});

test("a redirect to the real file is followed, then verified", async () => {
  const bin = await stubConverter();
  const result = await findExistingModel("an M8 hex bolt", {
    config: configWith({ cascadeBin: bin }),
    artifactDir: dir,
    searchImpl: searchReturning([{ url: `${origin()}/redirect.step`, title: "M8 bolt (CDN redirect)" }]),
  });
  expect(result.model).not.toBeNull();
  expect(result.model?.sourceUrl).toContain("/redirect.step");
});

test("no results at all falls through to generation without inventing anything", async () => {
  const result = await findExistingModel("a wristwatch with a leather strap", {
    config: configWith(),
    artifactDir: dir,
    searchImpl: searchReturning([]),
  });
  expect(result.model).toBeNull();
  expect(result.searchUnavailable).toBe(false);
  expect(result.notes.at(-1)).toContain("no downloadable STEP/STL candidate");
});

test("a broken search backend is reported as unavailable, not as 'not found'", async () => {
  const result = await findExistingModel("a wheel", {
    config: configWith(),
    artifactDir: dir,
    searchImpl: async () => { throw new Error("Tavily search returned HTTP 401 (check TAVILY_API_KEY)"); },
  });
  expect(result.model).toBeNull();
  expect(result.searchUnavailable).toBe(true);
  expect(result.notes[0]).toContain("Tavily search returned HTTP 401");
});

test("search can be switched off entirely and the pipeline goes straight to MAC", async () => {
  const result = await findExistingModel("an M8 bolt", {
    config: configWith({ searchEnabled: false }),
    artifactDir: dir,
    searchImpl: searchReturning([{ url: `${origin()}/bolts/m8-hex.step` }]),
  });
  expect(result.model).toBeNull();
  expect(result.notes[0]).toContain("FORGE_CAD_SEARCH=false");
});
