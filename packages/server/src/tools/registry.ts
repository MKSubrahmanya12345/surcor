import { z } from "zod";
import {
  applyDiffArgsSchema, hardwareBuildArgsSchema, hardwareListArgsSchema, hardwareProjectArgsSchema,
  listDirArgsSchema, readFileArgsSchema, runTerminalCommandArgsSchema,
  searchCodebaseArgsSchema, webSearchArgsSchema, writeFileArgsSchema,
  type AgentToolContext, type RegisteredTool, type ToolCall, type ToolDefinition, type ToolHandler, type ToolResult,
} from "@forge/shared";
import { readFile } from "./readFile";
import { writeFile } from "./writeFile";
import { listDir } from "./listDir";
import { runTerminalCommand } from "./runTerminalCommand";
import { applyDiff } from "./applyDiff";
import { searchCodebase } from "./searchCodebase";
import { webSearch } from "./webSearch";
import { hardwareBuild } from "./hardwareBuild";
import { hardwareList } from "./hardwareList";
import { hardwareProject } from "./hardwareProject";

// One registry for built-ins and future indexing/MCP tools. No loop changes needed.
export const toolRegistry = new Map<string, RegisteredTool>();

export function registerTool(definition: ToolDefinition, handler: ToolHandler): void {
  if (toolRegistry.has(definition.name)) throw new Error(`Tool already registered: ${definition.name}`);
  toolRegistry.set(definition.name, { definition, handler });
}

function parameters(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _version, ...json } = z.toJSONSchema(schema, { unrepresentable: "any" });
  return json;
}

registerTool({ name: "read_file", description: "Read a UTF-8 workspace file. Optional startLine/endLine are inclusive and 1-based.", parameters: parameters(readFileArgsSchema) }, readFile);
registerTool({ name: "write_file", description: "Create or overwrite a workspace file with exact UTF-8 content. Creates parent directories. Writes immediately; prefer apply_diff for reviewing changes to existing files.", parameters: parameters(writeFileArgsSchema) }, writeFile);
registerTool({ name: "list_dir", description: "List immediate files and directories in a workspace directory. Defaults to the workspace root.", parameters: parameters(listDirArgsSchema) }, listDir);
registerTool({ name: "run_terminal_command", description: "Run a one-shot shell command (sh on Unix, cmd on Windows). cwd is workspace-relative, not an OS sandbox. Output is streamed and capped; timeoutMs cannot exceed the configured command timeout.", parameters: parameters(runTerminalCommandArgsSchema) }, runTerminalCommand);
registerTool({ name: "apply_diff", description: "Propose full replacement content for a workspace file, not a unified patch. Saves a pending diff for human review; NEVER writes the file. Supply originalContent for a stale-read check. Do not treat pending proposals as applied or bypass review with write_file/terminal.", parameters: parameters(applyDiffArgsSchema) }, applyDiff);

// Prompt 5: codebase awareness and live web access. Same registry, same
// generic dispatch in agent/loop.ts — nothing else had to change.
registerTool({ name: "search_codebase", description: "Semantic search over the indexed workspace. Returns the most relevant code chunks with workspace-relative paths, line ranges and similarity scores. Use this FIRST to locate code by meaning (for example \"where is the WebSocket connection set up\") instead of guessing paths, then read_file for full context. pathPrefix narrows to a subtree; topK defaults to 6.", parameters: parameters(searchCodebaseArgsSchema) }, searchCodebase);
registerTool({ name: "web_search", description: "Search the live web (Tavily, falling back to Brave). Use for anything that must be current or is newer than the model's training data: library/tool versions, changelogs, API references, error messages. Returns titles, snippets and URLs; cite the URLs you rely on.", parameters: parameters(webSearchArgsSchema) }, webSearch);

// Prompt 7: the wireup agentic hardware engine. Runs a full hardware project
// build (components → pins → wiring → firmware → validation w/ target fixes)
// from a plain-English prompt, streaming every pipeline stage back as a
// tool_result_chunk. Offline machines degrade deterministically to the catalog.
// The hardware_* family shares one workstate store persisted in forge.sqlite.
registerTool({ name: "hardware_build", description: "Run the agentic hardware engineering pipeline on a plain-English prompt. Generates a complete hardware project: component selection, pin assignments, wiring plan, Arduino C++ firmware, validation with targeted fixes. Streams each pipeline stage back live and returns the final workstate JSON (every component, wiring net and code file). Pass projectId to continue an existing project: the new prompt is persisted (if given) and the build is regenerated as a new frozen revision vN+1, keeping all prior revisions.", parameters: parameters(hardwareBuildArgsSchema) }, hardwareBuild);
registerTool({ name: "hardware_list", description: "List hardware projects in the engine workstate: id, name, status, stage, revision, component/wiring/code counts. Use hardware_project to inspect one in full, or hardware_build with its projectId to continue it.", parameters: parameters(hardwareListArgsSchema) }, hardwareList);
registerTool({ name: "hardware_project", description: "Return the full workstate of an existing hardware project (components, pin assignments, wiring connections, firmware sources, validation issues, revision history). Use includeCode=false to omit the firmware sources. Then persist files into the workspace with write_file/apply_diff.", parameters: parameters(hardwareProjectArgsSchema) }, hardwareProject);

export function getToolDefinitions(): ToolDefinition[] {
  return [...toolRegistry.values()].map((tool) => tool.definition);
}

export async function executeTool(call: ToolCall, context: AgentToolContext): Promise<ToolResult> {
  try {
    context.signal.throwIfAborted();
    const tool = toolRegistry.get(call.name);
    if (!tool) throw new Error(`Unknown tool: ${call.name}`);
    const result = await tool.handler(call, context);
    if (Buffer.byteLength(result.output, "utf8") > context.maxOutputBytes) {
      result.output = Buffer.from(result.output).subarray(0, context.maxOutputBytes).toString("utf8") + "\n[Output truncated; request a smaller range.]";
    }
    return result;
  } catch (error) {
    return {
      toolCallId: call.id, ok: false, output: "",
      error: context.signal.aborted ? "Tool execution cancelled." : error instanceof z.ZodError
        ? `Invalid tool arguments: ${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`
        : error instanceof Error ? error.message : "Tool execution failed.",
    };
  }
}
