import { applyDiffArgsSchema, type DiffProposal, type ToolHandler } from "@forge/shared";
import { isMissing, readTextFile, resolveWorkspacePath } from "./paths";

export const applyDiff: ToolHandler = async (call, context) => {
  const args = applyDiffArgsSchema.parse(call.args);
  if (Buffer.byteLength(args.proposedContent, "utf8") > context.maxFileBytes) throw new Error("Proposed content exceeds the file size limit.");
  const filePath = await resolveWorkspacePath(context.workspaceRoot, args.path, true);
  let originalContent = "";
  try { originalContent = await readTextFile(filePath, context.maxFileBytes); }
  catch (error) { if (!isMissing(error)) throw error; }
  if (args.originalContent !== undefined && args.originalContent !== originalContent) {
    throw new Error("The file changed since it was read. Read it again before proposing a diff.");
  }
  context.signal.throwIfAborted();
  const diff: DiffProposal = {
    id: crypto.randomUUID(), filePath, originalContent, proposedContent: args.proposedContent, status: "pending",
  };
  context.database.saveDiff(context.sessionId, diff);
  context.emit({ type: "diff_proposed", diff });
  return { toolCallId: call.id, ok: true, output: JSON.stringify({
    diffId: diff.id, filePath, status: "pending", message: "Proposal saved for review. No file was written. The client applies it on acceptance.",
  }) };
};
