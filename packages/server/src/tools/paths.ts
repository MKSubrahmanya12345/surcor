import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertInside(root: string, path: string): void {
  const part = relative(root, path);
  if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) {
    throw new Error("File tools cannot access paths outside the workspace.");
  }
}

export async function validateWorkspaceRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("workspaceRoot must be an absolute path.");
  const root = await realpath(path);
  if (!(await stat(root)).isDirectory()) throw new Error("workspaceRoot must be a directory.");
  return root;
}

export async function resolveWorkspacePath(root: string, path: string, allowMissing = false): Promise<string> {
  if (!path || path.includes("\0")) throw new Error("Invalid workspace path.");
  const target = resolve(root, path);
  assertInside(root, target);
  let ancestor = target;
  const missing: string[] = [];
  while (true) {
    try {
      await lstat(ancestor);
    } catch (error) {
      if (!isMissing(error) || !allowMissing || ancestor === root) throw error;
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
      continue;
    }
    // A dangling symlink fails here rather than being mistaken for a new file.
    const canonical = await realpath(ancestor);
    assertInside(root, canonical);
    if (missing.length && !(await stat(canonical)).isDirectory()) throw new Error("Parent path is not a directory.");
    return resolve(canonical, ...missing);
  }
}

export async function readTextFile(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Path is not a regular file.");
    if (info.size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte file limit.`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte file limit.`);
    const bytes = buffer.subarray(0, offset);
    if (bytes.includes(0)) throw new Error("Binary files are not supported by text tools.");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } finally { await handle.close(); }
}

export async function writeTextFile(root: string, path: string, content: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  let target = await resolveWorkspacePath(root, path, true);
  await mkdir(dirname(target), { recursive: true });
  target = await resolveWorkspacePath(root, target, true);
  let mode = 0o666;
  try {
    const previous = await stat(target);
    if (!previous.isFile()) throw new Error("Path is not a regular file.");
    mode = previous.mode & 0o777;
  } catch (error) { if (!isMissing(error)) throw error; }
  const temporary = resolve(dirname(target), `.forge-${crypto.randomUUID()}.tmp`);
  try {
    signal.throwIfAborted();
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    signal.throwIfAborted();
    if (await resolveWorkspacePath(root, dirname(target)) !== dirname(target)) {
      throw new Error("Workspace path changed during the write.");
    }
    // Atomic replacement avoids leaving a partially truncated file on cancel.
    await rename(temporary, target);
    return target;
  } finally {
    await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw error; });
  }
}
