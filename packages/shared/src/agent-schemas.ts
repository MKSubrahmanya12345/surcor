import { z } from "zod";
import type {
  ApplyDiffArgs,
  ClientMessage,
  ListDirArgs,
  ReadFileArgs,
  RunTerminalCommandArgs,
  WriteFileArgs,
} from "./types";

const pathSchema = z.string().min(1).max(32_768).refine(
  (path) => !path.includes("\0"),
  "Paths cannot contain NUL characters",
);

export const clientMessageSchema: z.ZodType<ClientMessage> = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("user_message"),
    content: z.string().min(1).max(64_000).refine((value) => value.trim().length > 0),
    mode: z.enum(["ask", "agent", "plan"]),
  }),
  z.strictObject({
    type: z.literal("diff_decision"),
    diffId: z.string().uuid(),
    decision: z.enum(["accept", "reject"]),
  }),
  z.strictObject({ type: z.literal("cancel") }),
  z.strictObject({
    type: z.literal("init"),
    workspaceRoot: pathSchema,
    sessionId: z.string().uuid().optional(),
  }),
  z.strictObject({ type: z.literal("approve_plan") }),
]);

export const readFileArgsSchema: z.ZodType<ReadFileArgs> = z.strictObject({
  path: pathSchema,
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
});

export const writeFileArgsSchema: z.ZodType<WriteFileArgs> = z.strictObject({
  path: pathSchema,
  content: z.string().max(1_048_576),
});

export const listDirArgsSchema: z.ZodType<ListDirArgs> = z.strictObject({
  path: pathSchema.optional(),
});

export const runTerminalCommandArgsSchema: z.ZodType<RunTerminalCommandArgs> = z.strictObject({
  command: z.string().min(1).max(16_384).refine((value) => !value.includes("\0")),
  cwd: pathSchema.optional(),
  timeoutMs: z.number().int().min(1).max(300_000).optional(),
});

export const applyDiffArgsSchema: z.ZodType<ApplyDiffArgs> = z.strictObject({
  path: pathSchema,
  proposedContent: z.string().max(1_048_576),
  originalContent: z.string().max(1_048_576).optional(),
});
