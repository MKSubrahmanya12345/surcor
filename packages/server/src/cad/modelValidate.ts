import { open, stat } from "node:fs/promises";

/**
 * Model-file sanity checks that do not trust an HTTP 200.
 *
 * The problem this exists for: search results routinely hand back a login page,
 * a cookie wall, a Cloudflare challenge, or a half-transferred file saved under
 * a `.step` extension. Passing those to the viewer is how a fake "success" is
 * born, so every candidate is opened for real: header bytes, structure,
 * truncation, and — for STEP — a topology fingerprint counted off the entity
 * records themselves.
 *
 * Files are scanned in 1 MiB chunks (never slurped) so a 60 MB catalogue part
 * costs a stream; a 96-byte carry window across each chunk edge keeps an entity
 * name split by the boundary from being miscounted.
 */

export type ModelKind = "step" | "stl";

export interface ModelFingerprint {
  kind: ModelKind;
  bytes: number;
  /** Topology counts, read straight out of the STEP entity records. */
  solids: number;
  faces: number;
  planarFaces: number;
  curvedFaces: number;
  bsplineSurfaces: number;
  toroidalSurfaces: number;
  conicalSurfaces: number;
  cylindricalSurfaces: number;
  /** STL facets/triangles (0 for STEP); "is there any geometry at all". */
  facets: number;
  /** One solid, a handful of faces, no feature geometry: a bare primitive. */
  singleTrivialPrimitive: boolean;
  /** Human-readable summary, reused verbatim in progress/failure text. */
  summary: string;
}

export type ModelValidation =
  | { ok: true; kind: ModelKind; fingerprint: ModelFingerprint }
  | { ok: false; reason: string };

const CHUNK_BYTES = 1_048_576;
const CARRY_BYTES = 96;
const HEAD_BYTES = 65_536;
const TAIL_BYTES = 4_096;

interface ScanResult {
  counts: Record<string, number>;
  head: string;
  tail: string;
  bytes: number;
}

/** Streamed, case-insensitive, multi-pattern count over a file. */
async function scan(path: string, patterns: Record<string, RegExp>): Promise<ScanResult> {
  const keys = Object.keys(patterns);
  const counts: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 0]));
  const regexes = Object.fromEntries(keys.map((key) => [
    key, new RegExp(patterns[key].source, patterns[key].flags.replace("g", "").concat("g")),
  ])) as Record<string, RegExp>;
  const handle = await open(path, "r");
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let head = "";
  let tail = "";
  let carry = "";
  let offset = 0;
  try {
    const info = await handle.stat();
    while (offset < info.size) {
      const want = Math.min(CHUNK_BYTES, info.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, want, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      const text = carry + decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      for (const key of keys) {
        const regex = regexes[key];
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          // A hit entirely inside the carried tail was counted on the last chunk.
          if (carry && match.index + match[0].length <= carry.length) {
            regex.lastIndex = match.index + 1;
            continue;
          }
          counts[key] += 1;
          if (match[0].length === 0) regex.lastIndex = match.index + 1;
        }
      }
      if (head.length < HEAD_BYTES) head = (head + text).slice(0, HEAD_BYTES);
      tail = text.slice(-TAIL_BYTES);
      carry = text.slice(-CARRY_BYTES);
    }
    return { counts, head, tail, bytes: offset };
  } finally {
    await handle.close();
  }
}

const STEP_PATTERNS: Record<string, RegExp> = {
  solids: /\bMANIFOLD_SOLID_BREP\s*\(/i,
  shells: /\bCLOSED_SHELL\s*\(/i,
  faces: /\bADVANCED_FACE\s*\(/i,
  plane: /\bPLANE\s*[,(]/i,
  cylindrical: /\bCYLINDRICAL_SURFACE\s*\(/i,
  conical: /\bCONICAL_SURFACE\s*\(/i,
  toroidal: /\bTOROIDAL_SURFACE\s*\(/i,
  spherical: /\bSPHERICAL_SURFACE\s*\(/i,
  bspline: /\bB_SPLINE_SURFACE(?:_WITH_KNOTS)?\s*\(/i,
  edgeLoops: /\bEDGE_LOOP\s*\(/i,
};

const looksLikeHtml = (text: string): boolean => {
  const head = text.replace(/^/, "").trimStart().slice(0, 4096).toLowerCase();
  if (!head) return true;
  if (head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<head")) return true;
  if (head.startsWith("<?xml") && /<(!doctype\s+html|html\b)/.test(head)) return true;
  // JSON error bodies some hosts return with a 200 status and a .step filename.
  if (/^\{\s*"(error|message|detail|status)"\s*:/.test(head)) return true;
  return /<script|<body|<title|<a href=/.test(head);
};

/**
 * Validate + fingerprint a STEP (ISO-10303-21) file. `reason` is shown to the
 * user verbatim, so it always names the concrete problem.
 */
export async function validateStepFile(path: string, label = path): Promise<ModelValidation> {
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) return { ok: false, reason: `${label}: not a regular file.` };
  // Sniff before the size check: "you were served a login page" is far more
  // actionable than "this file is small", and the two are often the same event.
  const probe = await Bun.file(path).slice(0, 4096).text().catch(() => "");
  if (looksLikeHtml(probe)) {
    return { ok: false, reason: `${label}: served an HTML/JSON error page, not STEP data (login wall, cookie wall, quota page, or 404).` };
  }
  if (info.size < 256) return { ok: false, reason: `${label}: only ${info.size} bytes — too small to be a STEP model.` };
  const { counts, head, tail } = await scan(path, STEP_PATTERNS);
  const lowered = head.toLowerCase();
  const headerAt = lowered.indexOf("iso-10303-21;");
  if (headerAt < 0 || headerAt > 4096) {
    return { ok: false, reason: `${label}: no ISO-10303-21 header in the first 4 KiB — not a STEP physical file.` };
  }
  if (!lowered.includes("file_description(")) return { ok: false, reason: `${label}: STEP header has no FILE_DESCRIPTION entity.` };
  if (!lowered.includes("file_schema(")) return { ok: false, reason: `${label}: STEP header has no FILE_SCHEMA entity.` };
  if (!lowered.includes("data;")) return { ok: false, reason: `${label}: STEP file has no DATA section.` };
  const solids = Math.max(counts.solids ?? 0, counts.shells ?? 0);
  const faces = counts.faces ?? 0;
  if (solids === 0 && faces === 0) {
    return { ok: false, reason: `${label}: DATA section contains no solid/shell/face geometry (empty or unreadable).` };
  }
  if (!tail.toLowerCase().includes("end-iso-10303-21;")) {
    return { ok: false, reason: `${label}: truncated — the file ends without an END-ISO-10303-21 terminator.` };
  }
  const curved = (counts.cylindrical ?? 0) + (counts.conical ?? 0) + (counts.toroidal ?? 0)
    + (counts.spherical ?? 0) + (counts.bspline ?? 0);
  // A single box (6 planar faces), cylinder (<=3 faces, 1 curved), cone or
  // sphere. Anything actually built from a spec has more than this.
  const trivial = solids <= 1 && faces > 0 && faces <= 6 && (counts.bspline ?? 0) === 0
    && (counts.toroidal ?? 0) === 0 && (counts.conical ?? 0) === 0
    && (counts.cylindrical ?? 0) <= 1 && (counts.spherical ?? 0) <= 1;
  const fingerprint: ModelFingerprint = {
    kind: "step",
    bytes: info.size,
    solids,
    faces,
    planarFaces: counts.plane ?? 0,
    curvedFaces: curved,
    bsplineSurfaces: counts.bspline ?? 0,
    toroidalSurfaces: counts.toroidal ?? 0,
    conicalSurfaces: counts.conical ?? 0,
    cylindricalSurfaces: counts.cylindrical ?? 0,
    facets: 0,
    singleTrivialPrimitive: trivial,
    summary: `${(info.size / 1024).toFixed(0)} KiB STEP · ${solids} solid(s) · ${faces} faces `
      + `(${counts.plane ?? 0} planar, ${curved} curved, ${counts.edgeLoops ?? 0} edge loops)`,
  };
  return { ok: true, kind: "step", fingerprint };
}

export async function validateStlFile(path: string, label = path): Promise<ModelValidation> {
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) return { ok: false, reason: `${label}: not a regular file.` };
  if (info.size < 84) return { ok: false, reason: `${label}: only ${info.size} bytes — smaller than an STL header.` };
  const handle = await open(path, "r");
  let headText = "";
  try {
    const head = Buffer.allocUnsafe(Math.min(512, info.size));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    headText = head.subarray(0, Math.max(0, bytesRead)).toString("latin1");
  } finally {
    await handle.close();
  }
  if (looksLikeHtml(headText)) return { ok: false, reason: `${label}: served an HTML page, not STL data.` };

  const build = (facets: number, vertices: number, ascii: boolean): ModelFingerprint => ({
    kind: "stl", bytes: info.size, solids: 1, faces: facets, planarFaces: facets, curvedFaces: 0,
    bsplineSurfaces: 0, toroidalSurfaces: 0, conicalSurfaces: 0, cylindricalSurfaces: 0, facets,
    // A cube is 12 triangles; anything below that is a toy, not a part.
    singleTrivialPrimitive: facets <= 12,
    summary: `${(info.size / 1024).toFixed(0)} KiB ${ascii ? "ASCII" : "binary"} STL · ${facets} ${ascii ? "facets" : "triangles"}`
      + (ascii ? ` · ${vertices} vertices` : ""),
  });

  const asciiScan = await scan(path, {
    facets: /\bfacet\s+normal\b/i, endsolid: /\bendsolid\b/i, vertices: /\bvertex\b/i, outer: /\bouter loop\b/i,
  });
  if ((asciiScan.counts.facets ?? 0) > 0) {
    if ((asciiScan.counts.outer ?? 0) === 0 || (asciiScan.counts.vertices ?? 0) < (asciiScan.counts.facets ?? 0) * 3) {
      return { ok: false, reason: `${label}: ASCII STL has ${(asciiScan.counts.facets ?? 0)} facets but incomplete loops (truncated).` };
    }
    if (!asciiScan.tail.toLowerCase().includes("endsolid") && (asciiScan.counts.endsolid ?? 0) === 0) {
      return { ok: false, reason: `${label}: ASCII STL is truncated (no endsolid terminator).` };
    }
    return { ok: true, kind: "stl", fingerprint: build(asciiScan.counts.facets, asciiScan.counts.vertices, true) };
  }

  // Not ASCII — it must be a binary STL whose header count matches the file size.
  const binary = await open(path, "r");
  try {
    const header = Buffer.allocUnsafe(84);
    const { bytesRead } = await binary.read(header, 0, 84, 0);
    if (bytesRead < 84) return { ok: false, reason: `${label}: could not read an 84-byte STL header.` };
    const triangles = header.readUInt32LE(80);
    // A binary STL is exactly 84 + 50·n bytes; only a few bytes of trailing
    // padding are tolerated, so a dropped triangle cannot pass as complete.
    const expected = 84 + triangles * 50;
    if (triangles === 0 || info.size < expected || info.size - expected > 4) {
      return {
        ok: false,
        reason: `${label}: header claims ${triangles} triangles (${expected} bytes expected) but the file is ${info.size} bytes — corrupt or truncated.`,
      };
    }
    return { ok: true, kind: "stl", fingerprint: build(triangles, triangles * 3, false) };
  } finally {
    await binary.close();
  }
}

/**
 * Validate with an extension hint; the extension is never trusted over content.
 * A hinted validator that *rejects* falls through to the other reader first —
 * catalogue hosts mislabel files in both directions, and "the server called it
 * .stl" is not evidence.
 */
export async function validateModelFile(path: string, hint: ModelKind | "auto" = "auto"): Promise<ModelValidation> {
  const byName: ModelKind | null = /\.(step|stp)$/i.test(path) ? "step" : /\.stl$/i.test(path) ? "stl" : null;
  const kind = hint === "auto" ? byName : hint;
  if (kind === "stl" || kind === "step") {
    const first = kind === "stl" ? await validateStlFile(path, path) : await validateStepFile(path, path);
    if (first.ok) return first;
    const other = kind === "stl" ? await validateStepFile(path, path) : await validateStlFile(path, path);
    return other.ok ? other : first;
  }
  const handle = await open(path, "r");
  let probe = "";
  try {
    const buffer = Buffer.allocUnsafe(1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    probe = buffer.subarray(0, Math.max(0, bytesRead)).toString("latin1");
  } finally {
    await handle.close();
  }
  if (/iso-10303-21/i.test(probe)) return validateStepFile(path, path);
  if (/^\s*solid/i.test(probe)) return validateStlFile(path, path);
  return validateStepFile(path, path);
}

/**
 * How much feature geometry the wording of the request implies. Used only to
 * decide whether *rejecting* a single bare primitive is justified — never to
 * approve a model (MAC's own QA verdict is what approves).
 */
const FEATURE_WORDS = [
  "hole", "bore", "slot", "pocket", "thread", "bolt", "nut", "screw", "gear", "tooth",
  "teeth", "flange", "fillet", "chamfer", "rib", "boss", "hex", "hexagon", "knurl",
  "groove", "notch", "washer", "bearing", "wheel", "spoke", "keyway", "shoulder",
  "shaft", "cut", "hollow", "cavity", "arm", "link", "ring", "bracket", "cage",
  "gyro", "watch", "clock", "board", "pcb", "connector", "pin", "socket", "spring",
  "lever", "hinge", "pivot", "impeller", "blade", "disc", "disk", "stair",
  "enclosure", "propeller", "turbine", "clamp", "manifold", "bracket",
] as const;

export function impliedFeatureCount(prompt: string): number {
  const lower = prompt.toLowerCase();
  let count = 0;
  for (const word of FEATURE_WORDS) if (lower.includes(word)) count += 1;
  // Explicit dimensions ("M8", "40 mm", '1.5"') signal a real spec too.
  count += (lower.match(/\b\d+(\.\d+)?\s?(mm|cm|in|inch|")\b/g) ?? []).length;
  if (/\bm\d{1,3}\b/.test(lower)) count += 1;
  return count;
}
