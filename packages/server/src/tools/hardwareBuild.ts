/**
 * `hardware_build` — run the wireup agentic hardware pipeline on a plain-English
 * prompt and return the resulting workstate.
 *
 * The engine runs its full pipeline (understanding → component selection → pin
 * planning → wiring → firmware → diagram/assembly artifacts) with the configured
 * Bedrock provider when creds are present, or degrades deterministically to the
 * bundled catalog when they are not. Every progress stage is streamed back as a
 * tool_result_chunk so the user watches the build live.
 *
 * With `projectId` the build continues an existing project: it persists any new
 * prompt, then rebuilds the pipeline as revision vN+1 (`replanned_after_human_input`),
 * keeping every prior frozen revision in history.
 */

import { hardwareBuildArgsSchema } from "@forge/shared";
import type { ServerMessage, ToolHandler } from "@forge/shared";
import { createProjectRecord, getProjectState, persistState, runGeneration, type ProjectState } from "@forge/wireup";
import { summariseProject } from "./hardwareSummary";

function stageLine(state: ProjectState): string {
  return `[${state.stage}] ${state.status} — components: ${state.components.length}, ` +
    `wiring: ${state.wiring?.connections.length ?? 0}, code files: ${state.artifacts.code?.files.length ?? 0}, ` +
    `issues: ${state.validation?.issues.length ?? 0}`;
}

export const hardwareBuild: ToolHandler = async (call, context) => {
  const args = hardwareBuildArgsSchema.parse(call.args);
  if (!args.prompt && !args.projectId) {
    throw new Error("hardware_build needs a prompt, or an existing projectId to continue — pass at least one.");
  }
  context.signal.throwIfAborted();

  let projectId = args.projectId;
  let prompt = args.prompt;

  if (projectId) {
    const existing = await getProjectState(projectId);
    if (!existing) throw new Error(`hardware project ${projectId} does not exist. Create it with hardware_build without projectId.`);
    // Apply a prompt edit to the loaded project before regenerating.
    if (args.prompt && args.prompt.trim() !== existing.prompt) {
      await persistState(projectId, { prompt: args.prompt.trim() });
    }
    prompt ??= existing.prompt;
  } else {
    const created = await createProjectRecord({ prompt: prompt! });
    projectId = created.id;
  }
  context.signal.throwIfAborted();

  const existing = projectId === args.projectId ? await getProjectState(projectId) : null;
  const baseRevision = Math.max(1, (existing?.revision ?? 0) + 1);
  const reason = existing && existing.revision >= 1 ? "replanned_after_human_input" : "initial_generation";

  const chunk = (output: string): void => {
    const message: ServerMessage = {
      type: "tool_result_chunk", result: { toolCallId: call.id, ok: true, output }, stream: "stdout",
    };
    context.emit(message);
  };

  const state = await runGeneration(projectId, {
    baseRevision,
    reason,
    onProgress: (project) => chunk(stageLine(project)),
  });
  context.signal.throwIfAborted();

  return {
    toolCallId: call.id, ok: true,
    output: JSON.stringify({
      ...summariseProject(state),
      note: "Generated hardware lives in the engine workstate (persisted in forge.sqlite). " +
        "List projects with hardware_list, inspect one with hardware_project, and persist " +
        "the firmware/instructions into the workspace with write_file/apply_diff when you want them on disk.",
    }, null, 2),
  };
};