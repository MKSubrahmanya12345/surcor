import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { listDirArgsSchema, type FileNode, type ToolHandler } from "@forge/shared";
import { resolveWorkspacePath } from "./paths";

export const listDir: ToolHandler = async (call, context) => {
  const args = listDirArgsSchema.parse(call.args);
  context.signal.throwIfAborted();
  const path = await resolveWorkspacePath(context.workspaceRoot, args.path ?? ".");
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const nodes: FileNode[] = entries.slice(0, 2000).map((entry) => ({
    path: resolve(path, entry.name), name: entry.name, isDirectory: entry.isDirectory(),
  }));
  return { toolCallId: call.id, ok: true, output: JSON.stringify({ entries: nodes, truncated: entries.length > nodes.length }) };
};
