import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { loadCadConfig } from "../../packages/server/src/cad/config";
import { convertStepToGlb, inspectGlb, resolveCascadeBin } from "../../packages/server/src/cad/convertToGlb";

/**
 * The real STEP → GLB path, run against the actual `opencascade-tools` CLI
 * (OpenCascade Technology compiled to WebAssembly) when it is installed:
 *
 *   npm install -g opencascade-tools
 *
 * Everything else in Prompt 7 is verified against fakes and fixtures; this file
 * is the one place that proves the geometry kernel Forge depends on really can
 * read what MAC or a catalogue handed it, and that the file the viewer renders
 * contains actual triangles rather than an empty scene. When the CLI is absent
 * the suite skips it loudly instead of pretending it passed.
 */

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const configuredBin = process.env.FORGE_CAD_OCCT_BIN ?? "opencascade-tools";
const binary = await resolveCascadeBin(configuredBin);

test(`${binary ? "real" : "skipped"}: OpenCASCADE triangulates a flange STEP into a viewable GLB`, async () => {
  if (!binary) {
    console.warn("[prompt7] opencascade-tools not found — install with `npm i -g opencascade-tools` to run the kernel test");
    return;
  }
  const dir = await mkdtemp("/tmp/forge-cad-occt-");
  const { copyFile } = await import("node:fs/promises");
  await copyFile(`${FIXTURES}flange.step`, join(dir, "model.step"));

  const config = loadCadConfig({ FORGE_CAD_OCCT_BIN: binary } as never);
  const result = await convertStepToGlb(join(dir, "model.step"), dir, config, { name: "model" });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.method).toBe("opencascade-tools");
  expect(result.glbPath).toBe(join(dir, "model.glb"));

  const scene = await inspectGlb(result.glbPath!);
  expect(scene.ok).toBe(true);
  expect(scene.primitives).toBeGreaterThan(0);
  // A flange with a bore and four holes is nowhere near a 12-triangle box.
  expect(scene.triangles).toBeGreaterThan(200);
  expect(result.detail).toContain("triangles");
}, 120_000);   // the WASM kernel needs a few seconds for tessellation

test("the kernel test is not silently vacuous: the fixture is a real STEP", async () => {
  const text = await Bun.file(`${FIXTURES}flange.step`).text();
  expect(text.startsWith("ISO-10303-21;")).toBe(true);
  expect(text).toContain("END-ISO-10303-21;");
  expect(text).toMatch(/MANIFOLD_SOLID_BREP\(/);
  expect(text).toMatch(/CYLINDRICAL_SURFACE\(/);
});
