/**
 * Core project types: requirements, hardware plan, software plan, artifacts,
 * revisions and the serialised project state exchanged with the frontend.
 */

import type { ComponentSelection, LibraryRequirement, PowerBudget } from './component';
import type { ResolvedAssemblyPlan } from './assembly';
import type { BehavioralSpec } from './behavioral';
import type { Diagram } from './diagram';
import type { AgentEvent } from './generation';
import type { ExpandedBrief, EverflowState, HumanTask, IdeaGraphState, ProjectDoubt, ResearchFinding } from './everflow';
import type { ProjectAtlasState } from './project-atlas';
import type { ValidationResult } from './validation';
import type { PinAssignment, WiringPlan } from './wiring';

export type ProjectStatus =
  /** Phase 0: the doubt session is waiting for (or has collected) answers. */
  | 'intake'
  | 'pending'
  | 'running'
  | 'validating'
  | 'fixing'
  | 'completed'
  | 'completed_with_warnings'
  /** Finished, but blocking validation issues are still unresolved. */
  | 'completed_with_errors'
  | 'failed';

export type GenerationStage =
  | 'idle'
  | 'understanding'
  | 'catalog'
  | 'generating'
  | 'hardware'
  | 'pins'
  | 'wiring'
  | 'software'
  | 'code'
  | 'libraries'
  | 'diagram'
  | 'assembly'
  | 'instructions'
  | 'validating'
  | 'fixing'
  | 'completed'
  | 'failed';

/** Output of the project-understanding module. */
export interface ProjectRequirements {
  goal: string;
  summary: string;
  requirements: string[];
  inputs: string[];
  outputs: string[];
  behaviors: string[];
  constraints: string[];
  platformRequirements: string[];
  communicationRequirements: string[];
  powerRequirements: string[];
  /** Numeric hints extracted from the prompt (motors: 2, leds: 4 …). */
  quantities: Record<string, number>;
  /** Signals/features inferred from the text, e.g. `bluetooth`, `motor_control`. */
  features: string[];
  /** Assumptions the agent made where the prompt was silent. */
  assumptions: string[];
  /** Open questions the user could answer to improve the result. */
  ambiguities: string[];
  /** Platform detected in the prompt, when any (`esp32`, `arduino-uno` …). */
  detectedPlatform?: string;
  /**
   * Checkable behaviours derived from the prompt (same tier as the prose
   * `requirements`/`behaviors` above). Populated at decomposition, verified
   * statically and against the emulated firmware by the behaviour evaluator.
   */
  behavioralSpec?: BehavioralSpec;
}

export interface HardwareBlock {
  id: string;
  name: string;
  description: string;
  /** Instance ids that make up this block. */
  instanceIds: string[];
  kind: 'controller' | 'power' | 'drive' | 'sensing' | 'communication' | 'actuation' | 'support';
}

export interface Subsystem {
  id: string;
  name: string;
  description: string;
  instanceIds: string[];
  inputs: string[];
  outputs: string[];
}

export interface CompatibilityCheck {
  a: string;
  b: string;
  compatible: boolean;
  reason: string;
}

export interface HardwarePlan {
  summary: string;
  architecture: HardwareBlock[];
  controller: {
    instanceId: string;
    componentId: string;
    name: string;
    reason: string;
  } | null;
  power: PowerBudget;
  subsystems: Subsystem[];
  /** High level signal flow, e.g. ["Bluetooth command", "Command parser", …]. */
  signalFlow: string[];
  compatibility: CompatibilityCheck[];
  supportingComponents: { instanceId: string; componentId: string; reason: string }[];
  risks: string[];
}

export interface SoftwareModule {
  id: string;
  name: string;
  responsibility: string;
  dependsOn: string[];
}

export interface ControlState {
  id: string;
  name: string;
  description: string;
  transitions: { to: string; when: string }[];
}

export interface CommandSpec {
  command: string;
  meaning: string;
  response?: string;
}

export interface SoftwarePlan {
  architecture: string;
  language: 'arduino-cpp' | 'c' | 'micropython' | 'python' | 'other';
  framework?: string;
  modules: SoftwareModule[];
  libraries: LibraryRequirement[];
  controlStates: ControlState[];
  inputHandling: string[];
  sensorLogic: string[];
  actuatorLogic: string[];
  communication: {
    protocol: string;
    transport: string;
    details: string;
    commandSet: CommandSpec[];
  } | null;
  safety: string[];
  loopStrategy: string;
  files: { path: string; purpose: string }[];
}

export interface GeneratedCodeFile {
  path: string;
  language: string;
  content: string;
  purpose: string;
  /** Which stage produced/last touched this file. */
  generatedBy: 'model' | 'planner' | 'fixer';
}

export interface CodeArtifact {
  files: GeneratedCodeFile[];
  entryPoint: string;
  /** True when the pin constant block was re-derived from the pin planner. */
  pinsSynchronised: boolean;
  notes: string[];
}

export interface LibrariesArtifact {
  libraries: LibraryRequirement[];
  installCommands: string[];
  notes: string[];
  generatedAt: string;
}

export interface InstructionSection {
  id: string;
  title: string;
  body: string;
  order: number;
}

export interface InstructionsArtifact {
  markdown: string;
  sections: InstructionSection[];
  billOfMaterials: { name: string; quantity: number; notes?: string }[];
  estimatedBuildTimeMinutes?: number;
  generatedAt: string;
}

export interface ProjectArtifacts {
  code: CodeArtifact | null;
  diagram: Diagram | null;
  libraries: LibrariesArtifact | null;
  instructions: InstructionsArtifact | null;
}

export interface GenerationError {
  stage: GenerationStage;
  code: string;
  message: string;
  details?: string;
  occurredAt: string;
  /** True when the failure was retryable (network/timeout) but retries ran out. */
  retryable?: boolean;
}

export interface LlmCallRecord {
  id: string;
  op: 'generation' | 'validation' | 'firmware_review' | 'fix' | 'codegen' | 'assembly';
  model: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: 'ok' | 'failed';
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
  iteration?: number;
}

/** A frozen snapshot of a project version so the UI can show exact diffs. */
export interface RevisionSnapshot {
  components: ComponentSelection[];
  pinAssignments: PinAssignment[];
  wiring: WiringPlan | null;
  code: CodeArtifact | null;
  diagram: Diagram | null;
  libraries: LibrariesArtifact | null;
  instructions: InstructionsArtifact | null;
  assembly: ResolvedAssemblyPlan | null;
}

export interface ProjectRevision {
  version: number;
  reason: 'initial_generation' | 'targeted_fix' | 'firmware_edit' | 'replanned_after_human_input';
  createdAt: string;
  summary: string;
  stage: GenerationStage;
  changes: import('./generation').FixChange[];
  /** Issues that motivated this revision (empty for the initial generation). */
  addressedIssueIds: string[];
  validation: {
    passed: boolean;
    errors: number;
    warnings: number;
  } | null;
  snapshot: RevisionSnapshot;
}

export interface IterationState {
  current: number;
  max: number;
}

/* ------------------------------------------------------------------------- */
/* Firmware workbench chat                                                    */
/* ------------------------------------------------------------------------- */

/** Outcome of one firmware-chat turn (or a manual editor save). */
export type ChatOutcome =
  /** The model changed the firmware; `diff` describes the change. */
  | 'applied'
  /** The model answered without touching code. */
  | 'answer'
  /** A change was proposed but refused by a gate (rooting/compile). */
  | 'rejected'
  /** The turn failed (model unavailable, persistence, ...). */
  | 'failed';

/** One line of a unified, line-based diff (computed server-side, persisted). */
export interface ChatDiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
  /** 1-based line in the old file (`del`/`same`). */
  oldLine?: number;
  /** 1-based line in the new file (`add`/`same`). */
  newLine?: number;
}

export interface ChatDiff {
  path: string;
  added: number;
  removed: number;
  /** Truncated for storage — very large diffs show the first hunks only. */
  truncated: boolean;
  lines: ChatDiffLine[];
}

/** A message in the firmware workbench chat. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  outcome?: ChatOutcome;
  /** The revision this turn produced (applied) or inspected. */
  revision?: number;
  /** Files touched by an applied change. */
  files?: string[];
  /** The unified diff of an applied change (capped). */
  diff?: ChatDiff;
  /** Compile/rule diagnostics attached to a rejected or applied turn. */
  diagnostics?: string[];
}

/** The serialised project as consumed by the API and the frontend. */
export interface ProjectState {
  id: string;
  name: string;
  prompt: string;
  status: ProjectStatus;
  stage: GenerationStage;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: GenerationError | null;
  requirements: ProjectRequirements | null;
  components: ComponentSelection[];
  hardwarePlan: HardwarePlan | null;
  pinAssignments: PinAssignment[];
  wiring: WiringPlan | null;
  softwarePlan: SoftwarePlan | null;
  /**
   * The 3D shape of the build (vehicle archetype, chassis, per-part seats).
   * Planned after the diagram; null for builds that predate the stage.
   */
  assembly: ResolvedAssemblyPlan | null;
  artifacts: ProjectArtifacts;
  validation: ValidationResult | null;
  revisions: ProjectRevision[];
  events: AgentEvent[];
  iteration: IterationState;
  llm: {
    model?: string;
    validationModel?: string;
    calls: LlmCallRecord[];
  };
  /** Firmware workbench conversation (user instructions + agent replies). */
  chat: ChatMessage[];
  /** Current revision number (1 = initial generation). */
  revision: number;

  /* ---------------- Everflow (the project graph + human channel) ---------------- */
  /** Intake doubt session: the questions the agent asked before building. */
  doubts: ProjectDoubt[];
  /**
   * The two-directional human channel. `ai_to_human` = asks the agent files;
   * `human_to_ai` = additions the human makes that the agent cannot have.
   */
  humanTasks: HumanTask[];
  /** Materialised project graph + last evaluation (see /modules/everflow). */
  everflow: EverflowState;
  /**
   * Resolved doubt-session context, folded into the prompt the understanding
   * stage sees. Null until the session produces answers.
   */
  intakeContext: string | null;
  /** The messy prompt normalised into the global project document. */
  expandedBrief: ExpandedBrief | null;
  /** The agent's docs/web research findings (cited evidence). */
  research: ResearchFinding[];
  /**
   * The idea graph — the recursive decomposition, per-node tests, reviewer
   * verdict and swarm assignments. Optional so pre-idea-graph persisted
   * documents and hand-built fixtures stay valid; `materializeGraph` renders
   * it into the same projected graph when present.
   */
  ideaGraph?: IdeaGraphState | null;
  /** Domain-neutral source clone, provenance graph and target transformation state. */
  atlas?: ProjectAtlasState | null;
}
