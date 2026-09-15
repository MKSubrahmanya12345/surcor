import { z } from "zod";
import type {
  ApplyDiffArgs,
  ClientMessage,
  HardwareBuildArgs,
  HardwareListArgs,
  HardwareProjectArgs,
  ListDirArgs,
  ReadFileArgs,
  RunTerminalCommandArgs,
  SearchCodebaseArgs,
  WebSearchArgs,
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
  // --- Prompt 6 variants (appended; existing variants unchanged) ---
  z.strictObject({ type: z.literal("mcp_status_request") }),
  z.strictObject({ type: z.literal("mcp_reload") }),
  // --- Prompt 7 variant (appended; existing variants unchanged) ---
  // CAD mode deliberately does not ride on `user_message`: a text-to-model run
  // is not an agent turn, and the provider's tool loop must never see it.
  z.strictObject({
    type: z.literal("cad_generate"),
    prompt: z.string().min(1).max(4_000).refine((value) => value.trim().length > 0),
  }),
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

// --- Prompt 5: codebase search + web search tool arguments -----------------
// Appended below the Prompt 3 schemas; no existing schema was changed.

export const searchCodebaseArgsSchema: z.ZodType<SearchCodebaseArgs> = z.strictObject({
  query: z.string().min(1).max(2_000).refine((value) => value.trim().length > 0),
  topK: z.number().int().min(1).max(25).optional(),
  pathPrefix: pathSchema.optional(),
});

export const webSearchArgsSchema: z.ZodType<WebSearchArgs> = z.strictObject({
  query: z.string().min(1).max(500).refine((value) => value.trim().length > 0),
  maxResults: z.number().int().min(1).max(10).optional(),
});

<<<<<<< HEAD
export const hardwareBuildArgsSchema: z.ZodType<HardwareBuildArgs> = z.strictObject({
  prompt: z.string().min(1).max(16_000).refine((value) => value.trim().length > 0).optional(),
  projectId: z.string().min(1).max(128).optional(),
});

export const hardwareListArgsSchema: z.ZodType<HardwareListArgs> = z.strictObject({
  topK: z.number().int().min(1).max(100).optional(),
});

export const hardwareProjectArgsSchema: z.ZodType<HardwareProjectArgs> = z.strictObject({
  projectId: z.string().min(1).max(128),
  includeCode: z.boolean().optional(),
=======
// --- Prompt 7: CAD mode -------------------------------------------------
// Appended below the Prompt 5 schemas; no existing schema was changed. A CAD
// request is one object name/description sentence — MAC's Spec Planner turns it
// into a CADBrief, so the ceiling is generous but bounded (a pasted manual is a
// prompt-injection vector against a pipeline that executes generated code).

export const cadGenerateArgsSchema = z.strictObject({
  prompt: z.string().min(1).max(4_000).refine((value) => value.trim().length > 0),
>>>>>>> 1943ead57d4753cd93f43573d096935f3c07d7da
});
