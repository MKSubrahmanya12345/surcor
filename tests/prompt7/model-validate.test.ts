import { expect, test } from "bun:test";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  impliedFeatureCount,
  validateModelFile,
  validateStepFile,
  validateStlFile,
} from "../../packages/server/src/cad/modelValidate";
import { inspectGlb, looksLikeGlb } from "../../packages/server/src/cad/convertToGlb";

/**
 * These fixtures were exported by real OpenCASCADE (build123d 0.11), so the
 * fingerprints asserted here are a geometry kernel's output, not a hand-written
 * imitation: flange.step = bore + 4 bolt holes, plate.step = a bare box,
 * bolt.step = hex head + round shank.
 */
import { fixturePath } from "./fixture";

const scratch = (): string => mkdtempSync(`${tmpdir()}/forge-cad-validate-`);

test("a real STEP file is accepted with a truthful topology fingerprint", async () => {
  const result = await validateStepFile(fixturePath("flange.step"));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.fingerprint.solids).toBe(1);
  expect(result.fingerprint.faces).toBe(8);           // 2 planar + bore + 4 holes + OD
  expect(result.fingerprint.cylindricalSurfaces).toBe(6);
  expect(result.fingerprint.singleTrivialPrimitive).toBe(false);
  expect(result.fingerprint.summary).toContain("8 faces");
});

test("a bare box is recognised as the placeholder shape it must never be", async () => {
  const result = await validateStepFile(fixturePath("plate.step"));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.fingerprint.faces).toBe(6);
  expect(result.fingerprint.curvedFaces).toBe(0);
  expect(result.fingerprint.singleTrivialPrimitive).toBe(true);
  // …but only a *featureful* request is enough to reject it for that reason.
  expect(impliedFeatureCount("a closed 50x50x6 mm box")).toBeLessThan(2);
  expect(impliedFeatureCount("a circular flange, 80 mm OD, 30 mm bore, 4 holes")).toBeGreaterThanOrEqual(2);
});

test("an HTML login page saved as .step is rejected by content, not status", async () => {
  const dir = scratch();
  const path = join(dir, "bolt.step");
  await writeFile(path, "<!DOCTYPE html>\n<html><head><title>Sign in to McMaster-Carr</title></head>\n<body><a href=\"/login\">Log in</a></body></html>\n");
  const result = await validateStepFile(path);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain("HTML/JSON error page");
});

test("a JSON error body with a .step filename is rejected", async () => {
  const dir = scratch();
  const path = join(dir, "part.step");
  await writeFile(path, JSON.stringify({ error: "quota exceeded", status: 429 }, null, 2).padEnd(400, " "));
  const result = await validateStepFile(path, "part.step");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain("HTML/JSON error page");   // sniffed as a non-model body
});

test("a truncated STEP file is rejected instead of half-trusted", async () => {
  const dir = scratch();
  const path = join(dir, "truncated.step");
  const full = await Bun.file(fixturePath("flange.step")).text();
  // Cut the file where DATA is open: header intact, terminator gone.
  await writeFile(path, full.slice(0, Math.floor(full.length * 0.6)));
  const result = await validateStepFile(path);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain("truncated");
});

test("a STEP without FILE_SCHEMA is rejected even when the header looks right", async () => {
  const dir = scratch();
  const path = join(dir, "noschema.step");
  const body = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('x'),'2;1');\nENDSEC;\nDATA;\n#1=MANIFOLD_SOLID_BREP('',#2);\n#2=CLOSED_SHELL('',());\nENDSEC;\nEND-ISO-10303-21;\n";
  await writeFile(path, body.padEnd(400, "\n"));
  const result = await validateStepFile(path);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain("FILE_SCHEMA");
});

test("binary STL is validated against its own header count", async () => {
  const dir = scratch();
  const triangles = 4;
  const path = join(dir, "ok.stl");
  const buffer = Buffer.alloc(84 + triangles * 50);
  buffer.writeUInt32LE(triangles, 80);
  await writeFile(path, buffer);
  const ok = await validateStlFile(path);
  expect(ok.ok).toBe(true);
  if (!ok.ok) return;
  expect(ok.fingerprint.faces).toBe(triangles);

  // Same file, one triangle short of what the header claims → rejected.
  const broken = join(dir, "broken.stl");
  await copyFile(path, broken);
  await writeFile(broken, buffer.subarray(0, buffer.length - 50));
  const result = await validateStlFile(broken, "broken.stl");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain("corrupt or truncated");
});

test("ASCII STL needs its terminator", async () => {
  const dir = scratch();
  const facet = "  facet normal 0 0 1\n    outer loop\n      vertex 0 0 0\n      vertex 1 0 0\n      vertex 0 1 0\n    endloop\n  endfacet\n";
  const whole = `solid part\n${facet}${facet}${facet}${facet}endsolid part\n`;
  await writeFile(join(dir, "ascii.stl"), whole);
  expect((await validateStlFile(join(dir, "ascii.stl"), "ascii.stl")).ok).toBe(true);
  await writeFile(join(dir, "ascii-cut.stl"), whole.slice(0, whole.length - 20));
  const cut = await validateStlFile(join(dir, "ascii-cut.stl"), "ascii-cut.stl");
  expect(cut.ok).toBe(false);
  if (cut.ok) return;
  expect(cut.reason).toContain("truncated");
});

test("validateModelFile judges by content when the extension lies", async () => {
  const dir = scratch();
  const fakeStep = join(dir, "wristwatch.step");
  await writeFile(fakeStep, "<html><body>GrabCAD — please log in to download</body></html>");
  const result = await validateModelFile(fakeStep, "auto");
  expect(result.ok).toBe(false);

  const realStepCopy = join(dir, "model.stl");   // wrong extension, STEP content
  await copyFile(fixturePath("flange.step"), realStepCopy);
  const sniffed = await validateModelFile(realStepCopy, "auto");
  expect(sniffed.ok).toBe(true);
});

test("GLB inspection demands an actual scene", async () => {
  const dir = scratch();
  await mkdir(dir, { recursive: true });
  const empty = join(dir, "empty.glb");
  const json = JSON.stringify({ asset: { version: "2.0" }, meshes: [] });
  const padded = json + " ".repeat((4 - (json.length % 4)) % 4);
  const header = Buffer.alloc(20);
  header.write("glTF", 0, "latin1");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  await writeFile(empty, Buffer.concat([header, Buffer.from(padded, "latin1")]));
  expect(await looksLikeGlb(empty)).toBe(true);          // a well-formed container…
  const scene = await inspectGlb(empty);
  expect(scene.ok).toBe(false);                          // …with nothing in it
  expect(scene.error).toContain("no mesh primitives");

  const truncated = join(dir, "trunc.glb");
  await writeFile(truncated, Buffer.concat([header, Buffer.from(padded.slice(0, 20), "latin1")]));
  expect(await looksLikeGlb(truncated)).toBe(false);
});
