import { writeFileArgsSchema, type ToolHandler } from "@forge/shared";
import { writeTextFile } from "./paths";

export const writeFile: ToolHandler = async (call, context) => {
  const args = writeFileArgsSchema.parse(call.args);
  if (Buffer.byteLength(args.content, "utf8") > context.maxFileBytes) throw new Error("Content exceeds the file size limit.");
  const path = await writeTextFile(context.workspaceRoot, args.path, args.content, context.signal);
  return { toolCallId: call.id, ok: true, output: `Wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${path}.` };
};
