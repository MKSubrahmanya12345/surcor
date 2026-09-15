/**
 * `hardware_list` — enumerate hardware projects in the engine workstate.
 */

import { hardwareListArgsSchema } from "@forge/shared";
import type { ToolHandler } from "@forge/shared";
import { listProjectStates } from "@forge/wireup";

export const hardwareList: ToolHandler = async (call, _context) => {
  const args = hardwareListArgsSchema.parse(call.args);
  const states = await listProjectStates(args.topK ?? 25);
  const rows = states.map((s) => ({
    projectId: s.id,
    name: s.name,
    prompt: s.prompt.length > 200 ? `${s.prompt.slice(0, 200)}…` : s.prompt,
    status: s.status,
    stage: s.stage,
    revision: s.revision,
    components: s.components.length,
    wiring: s.wiring?.connections.length ?? 0,
    codeFiles: s.artifacts.code?.files.length ?? 0,
    updatedAt: s.updatedAt,
  }));
  return {
    toolCallId: call.id, ok: true,
    output: rows.length
      ? JSON.stringify({ count: rows.length, projects: rows }, null, 2)
      : "No hardware projects yet. Create one with hardware_build.",
  };
};