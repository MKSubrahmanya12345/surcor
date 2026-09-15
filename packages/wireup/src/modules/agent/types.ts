/**
 * AGENTIC HARDWARE SYSTEM — TYPE DEFINITIONS.
 *
 * Defines the blackboard working state, tool interfaces, and action records
 * for the autonomous hardware engineering agent.
 */

import type { AgentEventLog } from '@/lib/logging/events';
import type { ComponentDefinition, ComponentSelection } from '@/types/component';
import type { PinAssignment, WiringPlan } from '@/types/wiring';
import type { Diagram } from '@/types/diagram';
import type { CodeArtifact, HardwarePlan, InstructionsArtifact, LibrariesArtifact, ProjectRequirements, SoftwarePlan } from '@/types/project';
import type { PromptAnalysis } from '@/modules/project-understanding/heuristics';
import type { I2CBus, SerialLink } from '@/modules/pin-planner';

export interface AgentFirmwareCompileStatus {
  /** `skipped` is an honest non-verdict (disabled or no host compiler). */
  status: 'passed' | 'failed' | 'skipped' | 'unavailable';
  compiler?: string;
  durationMs?: number;
  diagnostics: string[];
  skippedReason?: string;
}

export interface AgentBlackboard {
  prompt: string;
  projectName: string;
  analysis: PromptAnalysis;
  requirements: ProjectRequirements;
  catalog: ComponentDefinition[];
  workingCatalog: ComponentDefinition[];
  
  // Working hardware & schematic state
  selections: ComponentSelection[];
  hardwarePlan: HardwarePlan | null;
  pinAssignments: PinAssignment[];
  serialLinks: SerialLink[];
  i2cBuses: I2CBus[];
  wiring: WiringPlan | null;
  softwarePlan: SoftwarePlan | null;
  
  // Working artifacts
  code: CodeArtifact | null;
  /** Compile-gate verdict for the current `code` artifact, if one exists. */
  firmwareCompile: AgentFirmwareCompileStatus | null;
  /** Bounded diagnostics-informed repairs for the current circuit topology. */
  firmwareRepairAttempts: number;
  diagram: Diagram | null;
  libraries: LibrariesArtifact | null;
  instructions: InstructionsArtifact | null;
  
  // Design validation
  drcIssues: string[];
  notes: string[];
}

export interface AgentToolParam {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  items?: { type: string };
  required?: boolean;
}

export interface AgentToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, AgentToolParam>;
    required?: string[];
  };
}

export interface AgentToolResult {
  success: boolean;
  message: string;
  data?: unknown;
  error?: string;
}

/** A provider-neutral tool call. The runner validates `arguments` locally —
 * model output is never trusted as a tool input just because it is structured. */
export interface AgentModelToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface AgentModelToolOutput {
  callId: string;
  output: string;
}

export interface AgentModelTurnInput {
  turn: number;
  systemPrompt: string;
  /** Initial user request, or bounded diagnostics feedback for a repair pass. */
  userPrompt?: string;
  tools: AgentToolSchema[];
  toolOutputs?: AgentModelToolOutput[];
}

export interface AgentModelTurn {
  /** A concise operational status, not private chain-of-thought. */
  statusText?: string;
  toolCalls: AgentModelToolCall[];
}

/**
 * Model seam for the hardware agent. Production supplies Bedrock Converse or
 * Astra Responses; tests can supply a deterministic scripted driver without
 * credentials or network access.
 */
export interface AgentModelDriver {
  model: string;
  transport: 'bedrock' | 'openai-responses' | 'test';
  reason: string;
  next: (input: AgentModelTurnInput) => Promise<AgentModelTurn>;
}

export interface AgentToolContext {
  blackboard: AgentBlackboard;
  events: AgentEventLog;
}

export interface AgentTool {
  schema: AgentToolSchema;
  execute: (args: Record<string, unknown>, context: AgentToolContext) => Promise<AgentToolResult> | AgentToolResult;
}

export interface AgentAction {
  tool: string;
  args: Record<string, unknown>;
  thought?: string;
}

export interface AgentStepRecord {
  step: number;
  thought?: string;
  action?: AgentAction;
  result?: AgentToolResult;
  timestamp: string;
}
