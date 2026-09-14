import { writeFileArgsSchema, type ToolHandler } from "@forge/shared";
import { reindexFile } from "../index/service";
import { writeTextFile } from "./paths";

export const writeFile: ToolHandler = async (call, context) => {
  const args = writeFileArgsSchema.parse(call.args);
  if (Buffer.byteLength(args.content, "utf8") > context.maxFileBytes) throw new Error("Content exceeds the file size limit.");
  const path = await writeTextFile(context.workspaceRoot, args.path, args.content, context.signal);
  // Re-embed this file now so the next search_codebase reflects the write.
  // reindexFile swallows its own errors: a stale index degrades answers, it
  // must never fail a successful write.
  await reindexFile(context.workspaceRoot, path, context.signal);
  return { toolCallId: call.id, ok: true, output: `Wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${path}.` };
};
