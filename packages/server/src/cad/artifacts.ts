import { stat } from "node:fs/promises";
import { realpath, stat as fsStat } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import type { CadConfig } from "./config";

/**
 * Read-only HTTP access to Forge's CAD cache, so the renderer can point
 * `<model-viewer src>` and the Download buttons at a verified artifact.
 *
 * There is deliberately no way to ask this route for an arbitrary file: only
 * paths that resolve (after symlink resolution) to *inside*
 * `FORGE_CAD_ARTIFACT_DIR` are served, and only with a CAD extension. It is the
 * same directory the pipeline writes, and nothing else writes it. The agent
 * server's optional `FORGE_SERVER_TOKEN` applies here too, because a browser
 * cannot set an Authorization header on a `<model-viewer>` src — the token rides
 * as a query parameter, exactly like the WebSocket handshake does.
 */

const MEDIA_TYPES: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".step": "application/step",
  ".stp": "application/step",
  ".stl": "model/stl",
  ".json": "application/json",
  ".py": "text/x-python; charset=utf-8",
};

const timingSafeEquals = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return mismatch === 0;
};

/** True when `file` is `dir` or strictly inside it (separator-aware). */
const contains = (dir: string, file: string): boolean =>
  file === dir || file.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** Resolve `path` only when it stays inside the CAD cache directory. */
export async function resolveArtifactPath(raw: string, config: CadConfig): Promise<string | null> {
  if (!raw || raw.includes("\0")) return null;
  const root = resolve(config.artifactDir);
  let candidate: string;
  try {
    candidate = resolve(raw);
  } catch {
    return null;
  }
  if (candidate !== root && !contains(root, candidate)) return null;
  if (!(extname(candidate).toLowerCase() in MEDIA_TYPES)) return null;
  // Follow symlinks on both sides so a link out of the cache is rejected too.
  const [realRoot, realCandidate] = await Promise.all([
    realpath(root).catch(() => root),
    realpath(candidate).catch(() => null),
  ]);
  if (!realCandidate) return null;
  if (realCandidate !== realRoot && !contains(realRoot, realCandidate)) return null;
  const info = await fsStat(realCandidate).catch(() => null);
  if (!info || !info.isFile()) return null;
  return realCandidate;
}

/** Serves a cached CAD artifact, or a 403/404 — it never returns "no answer". */
export async function serveCadArtifact(
  request: Request,
  config: CadConfig,
  token?: string,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.searchParams.get("path") ?? "";
  if (token && !timingSafeEquals(url.searchParams.get("token") ?? "", token)) {
    return new Response("Forbidden", { status: 403 });
  }
  const resolved = await resolveArtifactPath(path, config);
  if (!resolved) return new Response("Not found", { status: 404 });
  const info = await stat(resolved);
  const type = MEDIA_TYPES[extname(resolved).toLowerCase()] ?? "application/octet-stream";
  const headers = new Headers({
    "content-type": type,
    "content-length": String(info.size),
    // A model may be re-generated into the same job directory; never cache it.
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    // `?dl=1` is what the Download STEP / Download GLB buttons append: a browser
    // cannot set a header on a plain link, and the anchor's `download` attribute
    // is ignored cross-origin, so the disposition has to come from the server.
    "content-disposition": url.searchParams.get("dl") === "1"
      ? `attachment; filename="${basename(resolved) || "model"}"`
      : "inline",
  });
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  // Bun.file hands the response a zero-copy file stream (models run to tens of MB).
  return new Response(Bun.file(resolved), { status: 200, headers });
}
