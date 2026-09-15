/**
 * `hardware_project` — return the full workstate of an existing hardware project
 * so the agent can materialise or reason about it. Sets includeCode=false when
 * the firmware sources are not needed (they dominate the payload).
 */

import { hardwareProjectArgsSchema } from "@forge/shared";
import type { ToolHandler } from "@forge/shared";
import { getProjectState } from "@forge/wireup";
import { summariseProject } from "./hardwareSummary";

export const hardwareProject: ToolHandler = async (call, _context) => {
  const args = hardwareProjectArgsSchema.parse(call.args);
  const state = await getProjectState(args.projectId);
  if (!state) throw new Error(`hardware project ${args.projectId} does not exist. List projects with hardware_list.`);
  return {
    toolCallId: call.id, ok: true,
    output: JSON.stringify(summariseProject(state, args.includeCode ?? true), null, 2),
  };
};