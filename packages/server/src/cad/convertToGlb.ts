import { access, copyFile, mkdir, rename, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter as pathDelimiter, basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { CadConfig } from "./config";

/**
 * STEP → GLB, the single conversion path every CAD result goes through —
 * whether the STEP came from a manufacturer's download or from MAC. One
 * function, two callers; the viewer never learns which.
 *
 * The converter is the `opencascade-tools` npm CLI (`npm i -g
 * opencascade-tools`), which triangulates through OpenCascade Technology in
 * WebAssembly — the same kernel family FreeCAD uses — and writes
 * `<sourceDir>/<sourceBase>.glb` next to its input. That naming is why this
 * module copies the source into the job directory under a controlled name
 * first: the output path has to be predictable, and the CLI accepts no
 * `--output` flag.
 *
 * Nothing here ever "converts" a placeholder: an absent/broken tool produces
 * an explicit error, not an empty scene.
 */

export interface ConversionResult {
  ok: boolean;
  /** Absolute path of the GLB inside Forge's CAD cache. */
  glbPath?: string;
  bytes?: number;
  method?: "opencascade-tools" | "sidecar-glb";
  /** Specific, user-visible explanation of a failed conversion. */
  error?: string;
  /** One-line summary for the progress log. */
  detail: string;
}

const GLB_MAGIC = "glTF";

export async function looksLikeGlb(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile() || info.size < 32) return false;
  const file = Bun.file(path);
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (String.fromCharCode(head[0], head[1], head[2], head[3]) !== GLB_MAGIC) return false;
  const version = new DataView(head.buffer).getUint32(4, true);
  const declared = new DataView(head.buffer).getUint32(8, true);
  // A real GLB states its total length in bytes 8..12; a truncated write fails here.
  return version === 2 && declared === info.size;
}

export interface GlbInspection {
  ok: boolean;
  meshes: number;
  primitives: number;
  triangles: number;
  bytes: number;
  error?: string;
}

/**
 * Parse the GLB container enough to prove there is a *scene* in it: a real
 * glTF JSON chunk, at least one mesh primitive, and non-zero triangle count.
 * A WASM kernel that "succeeds" while writing an empty buffer is a failure, and
 * an empty viewer is exactly the kind of fake success this feature forbids.
 */
export async function inspectGlb(path: string): Promise<GlbInspection> {
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) {
    return { ok: false, meshes: 0, primitives: 0, triangles: 0, bytes: 0, error: "file missing" };
  }
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const fail = (error: string): GlbInspection => ({ ok: false, meshes: 0, primitives: 0, triangles: 0, bytes: info.size, error });
  if (bytes.length < 20) return fail("shorter than a GLB header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "glTF") return fail("magic is not 'glTF'");
  if (view.getUint32(4, true) !== 2) return fail("GLB version is not 2");
  if (view.getUint32(8, true) !== bytes.length) return fail("declared length does not match the file size (truncated)");
  const chunkLength = view.getUint32(12, true);
  const chunkType = view.getUint32(16, true);
  if (chunkType !== 0x4e4f534a) return fail("first chunk is not the JSON chunk");
  if (12 + 8 + chunkLength > bytes.length) return fail("JSON chunk claims more bytes than the file holds");
  let json: { meshes?: { primitives?: unknown[] }[]; accessors?: { count?: number }[] };
  try {
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + chunkLength))) as typeof json;
  } catch (error) {
    return fail(`JSON chunk is not parseable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const meshes = json.meshes ?? [];
  const primitives = meshes.reduce((total, mesh) => total + (mesh.primitives?.length ?? 0), 0);
  if (primitives === 0) return fail("no mesh primitives in the scene");
  let triangles = 0;
  for (const mesh of meshes) {
    for (const raw of mesh.primitives ?? []) {
      const primitive = raw as { indices?: number; attributes?: { POSITION?: number } };
      const accessors = json.accessors ?? [];
      if (typeof primitive.indices === "number" && accessors[primitive.indices]?.count) {
        triangles += Math.floor(accessors[primitive.indices]!.count! / 3);
      } else if (typeof primitive.attributes?.POSITION === "number") {
        triangles += Math.floor((accessors[primitive.attributes.POSITION]?.count ?? 0) / 3);
      }
    }
  }
  if (triangles === 0) return fail("mesh primitives carry no triangles");
  return { ok: true, meshes: meshes.length, primitives, triangles, bytes: info.size };
}

const isExecutable = async (path: string): Promise<boolean> => {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * `opencascade-tools` may be installed globally (what the README tells you to
 * do), locally in the workspace, or not at all. Search those in order; on
 * Windows a bare name is resolved by the shell anyway, so it is left alone.
 */
export async function resolveCascadeBin(configured: string): Promise<string | null> {
  if (configured.includes("/") || configured.includes("\\")) {
    return (await isExecutable(configured)) ? configured : null;
  }
  const candidates = [configured];
  const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const roots = [
    resolve(import.meta.dir, "..", "..", ".."),                 // packages/server
    resolve(import.meta.dir, "..", "..", "..", ".."),           // repo root
  ];
  for (const root of roots) {
    for (const suffix of suffixes) {
      candidates.push(join(root, "node_modules", ".bin", `${configured}${suffix}`));
    }
  }
  candidates.push(join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), ".npm-global", "bin", configured));
  for (const directory of (process.env.PATH ?? "").split(pathDelimiter).filter(Boolean)) {
    for (const suffix of suffixes) candidates.push(join(directory, `${configured}${suffix}`));
  }
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Write the source STEP into `outDir/<name>.step` so the GLB lands beside it. */
async function stageStep(stepPath: string, outDir: string, name: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const ext = extname(stepPath).toLowerCase();
  const staged = join(outDir, `${name}${ext === ".stp" || ext === ".step" ? ext : ".step"}`);
  if (resolve(stepPath) !== staged) await copyFile(stepPath, staged);
  return staged;
}

export interface ConvertOptions {
  /** GLB the sidecar already produced (MAC renders one); used only if the CLI is missing. */
  fallbackGlbPath?: string | null;
  signal?: AbortSignal;
  /** Base name for the staged STEP + resulting GLB. */
  name?: string;
}

/**
 * Convert `stepPath` to a GLB inside `outDir`.
 *
 * `fallbackGlbPath` is not a second conversion function — it is a pass-through
 * of the sidecar's own render of the *same validated STEP/STL model*, used when
 * the CLI is unavailable. The result always says which of the two produced the
 * file, so a preview is never silently of unknown origin.
 */
export async function convertStepToGlb(
  stepPath: string,
  outDir: string,
  config: CadConfig,
  options: ConvertOptions = {},
): Promise<ConversionResult> {
  const name = options.name ?? "model";
  let staged: string;
  try {
    staged = await stageStep(stepPath, outDir, name);
  } catch (error) {
    return {
      ok: false,
      error: `Could not stage the STEP file for conversion: ${error instanceof Error ? error.message : String(error)}`,
      detail: "could not stage STEP for conversion",
    };
  }
  const expectedGlb = join(outDir, `${basename(staged, extname(staged))}.glb`);
  const bin = await resolveCascadeBin(config.cascadeBin);
  if (!bin) {
    const fallback = await trySidecarGlb(options.fallbackGlbPath, join(outDir, `${name}.glb`));
    if (fallback) return fallback;
    return {
      ok: false,
      error: `STEP→GLB conversion needs the opencascade-tools CLI, which is not installed. `
        + `Run: npm install -g opencascade-tools (or set FORGE_CAD_OCCT_BIN to its path). `
        + `The MAC sidecar's own preview GLB was also unavailable, and Forge will not render a placeholder.`,
      detail: `opencascade-tools not found (looked for "${config.cascadeBin}")`,
    };
  }

  let child: ReturnType<typeof Bun.spawn> | undefined;
  const timeout = new AbortController();
  const onExternalAbort = (): void => timeout.abort(new Error("Cancelled."));
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => timeout.abort(new Error(`conversion exceeded ${config.cascadeTimeoutMs} ms.`)), config.cascadeTimeoutMs);
  let stdout = "";
  let stderr = "";
  try {
    child = Bun.spawn([
      bin, "--format", "glb",
      "--linDeflection", String(config.cascadeLinDeflection),
      "--angDeflection", String(config.cascadeAngDeflection),
      staged,
    ], {
      cwd: outDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
      signal: timeout.signal,
    });
    const [out, err, exitCode] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    stdout = out.slice(-4000);
    stderr = err.slice(-4000);
    const produced = await looksLikeGlb(expectedGlb);
    if (!produced) {
      const fallback = await trySidecarGlb(options.fallbackGlbPath, join(outDir, `${name}.glb`));
      const why = exitCode === 0
        ? `${bin} exited 0 but wrote no readable GLB`
        : `${bin} exited ${exitCode}`;
      if (fallback) {
        return {
          ...fallback,
          detail: `${fallback.detail} — ${why}; used the sidecar's own render of the same model`,
        };
      }
      const detail = (stderr || stdout).split("\n").map((line) => line.trim()).filter(Boolean).slice(-2).join(" / ");
      return {
        ok: false,
        error: `OpenCascade could not triangulate this STEP into a GLB (${why}${detail ? `: ${detail}` : ""}). `
          + `The STEP was otherwise structurally valid; the mesh is what the viewer needs.`,
        detail: `${why}${detail ? ` — ${detail}` : ""}`,
      };
    }
    const finalPath = join(outDir, `${name}.glb`);
    if (expectedGlb !== finalPath) await rename(expectedGlb, finalPath);
    const scene = await inspectGlb(finalPath);
    if (!scene.ok) {
      return {
        ok: false,
        error: `OpenCASCADE produced a GLB that holds no scene (${scene.error}) — an empty viewer would be a lie, so this is reported as a failure.`,
        detail: `GLB has no triangles (${scene.error ?? "unreadable"})`,
      };
    }
    return {
      ok: true,
      glbPath: finalPath,
      bytes: scene.bytes,
      method: "opencascade-tools",
      detail: `GLB triangulated by opencascade-tools · ${scene.meshes} mesh(es), ${scene.primitives} primitive(s), `
        + `${scene.triangles.toLocaleString()} triangles · ${(scene.bytes / 1024).toFixed(0)} KiB`,
    };
  } catch (error) {
    const aborted = options.signal?.aborted === true;
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: aborted
        ? "Conversion was cancelled before it finished."
        : `STEP→GLB conversion failed to run (${bin}): ${message}`,
      detail: aborted ? "conversion cancelled" : `conversion spawn failed: ${message}`,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

async function trySidecarGlb(source: string | null | undefined, target: string): Promise<ConversionResult | null> {
  if (!source) return null;
  if (!(await looksLikeGlb(source))) return null;
  try {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    const scene = await inspectGlb(target);
    if (!scene.ok) return null;   // an empty render is no better than no render
    return {
      ok: true,
      glbPath: target,
      bytes: scene.bytes,
      method: "sidecar-glb",
      detail: `preview GLB taken from the sidecar's own render of the same model · ${scene.triangles.toLocaleString()} triangles · ${(scene.bytes / 1024).toFixed(0)} KiB`,
    };
  } catch {
    return null;
  }
}
