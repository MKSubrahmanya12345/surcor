import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Prompt 6 — project rules, the equivalent of Cursor's .cursor/rules.
 *
 * If `<workspaceRoot>/.forge/rules.md` exists, its contents are prepended to
 * the system message of every conversation. The file is read ONCE at
 * connection (init) time by server.ts and cached in the session's settings
 * row — it is NOT re-read on every message. Editing the file takes effect on
 * the next client connection, matching Cursor's restart-to-apply behavior.
 */

const MAX_RULES_BYTES = 16 * 1024;

export async function loadWorkspaceRules(workspaceRoot: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(join(workspaceRoot, ".forge", "rules.md"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (Buffer.byteLength(trimmed, "utf8") > MAX_RULES_BYTES) {
    return `${trimmed.slice(0, MAX_RULES_BYTES)}\n[Rules truncated at ${MAX_RULES_BYTES} bytes.]`;
  }
  return trimmed;
}
