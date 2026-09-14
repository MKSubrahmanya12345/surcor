import { readFileArgsSchema, type ToolHandler } from "@forge/shared";
import { readTextFile, resolveWorkspacePath } from "./paths";

export const readFile: ToolHandler = async (call, context) => {
  const args = readFileArgsSchema.parse(call.args);
  if (args.endLine !== undefined && args.endLine < (args.startLine ?? 1)) {
    throw new Error("endLine must be greater than or equal to startLine.");
  }
  context.signal.throwIfAborted();
  const path = await resolveWorkspacePath(context.workspaceRoot, args.path);
  const content = await readTextFile(path, context.maxFileBytes);
  return {
    toolCallId: call.id, ok: true,
    output: args.startLine !== undefined || args.endLine !== undefined
      ? content.split("\n").slice((args.startLine ?? 1) - 1, args.endLine).join("\n")
      : content,
  };
};
