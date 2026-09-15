/**
 * Everflow types — the project graph, per-node completion goals, the intake
 * doubt session and the two-directional human channel.
 *
 * The graph is the pipeline's own state made visible: nodes are created by
 * intake, pipeline stages, continuation passes or explicit human edits, and
 * the materialised graph is a projection of the persisted project state, so
 * nothing here can drift from what the workspace files actually contain.
 *
 * Two invariants this slice enforces:
 *   1. NO DANGLING NODES — a node whose goal is unmet must carry an open task
 *      (AI-owned or human-owned) or a named next action. `evaluateEverflow`
 *      reports any violation as an `openEnd`.
 *   2. NO SILENT SELF-MODIFICATION — human additions never mutate the design
 *      by themselves; they become facts, and a human-confirmed step (a new
 *      revision) is what applies them.
 */

/* ------------------------------------------------------------------------- */
/* Graph                                                                      */
/* ------------------------------------------------------------------------- */

export type EverflowNodeKind =
  | 'intent'
  | 'claim'
  | 'assumption'
  | 'decision'
  | 'goal'
  | 'doubt'
  | 'evidence'
  | 'task'
  | 'artifact'
  /* Idea graph — recursive decomposition of the intent into subsystems. */
  | 'subsystem'
  | 'test_result'
  | 'review';

export type EverflowNodeStatus = 'proposed' | 'active' | 'blocked' | 'human_review' | 'complete' | 'rejected';

export type EverflowEdgeKind =
  | 'supports'
  | 'depends_on'
  | 'contradicts'
  | 'produces'
  | 'verified_by'
  | 'part_of'
  | 'located_in'
  | 'answered_by';

export interface EverflowEdge {
  id: string;
  from: string;
  to: string;
  kind: EverflowEdgeKind;
  note?: string;
}

/* ------------------------------------------------------------------------- */
/* Idea graph — decomposition, per-node tests, swarms, review                  */
/* ------------------------------------------------------------------------- */

/**
 * The test ladder rungs, cheapest first. A leaf's test is the CHEAPEST rung
 * that can actually falsify the node — reusing the existing machinery
 * (catalog service, validator checks, compile shim, behavioural evaluator,
 * codegen rooting gate, human verify asks), never a new engine.
 */
export type TestRung = 'catalog' | 'electrical' | 'compile' | 'behavioral' | 'rooting' | 'human_verify';

/**
 * The per-node test contract. `assertion` is human language; `checkId`
 * points at the deterministic check the verdict maps to (a validation check
 * id like `power.budget`, a behavioural assertion id, a catalog part id, an
 * artifact path, or the id of a filed human ask). Status is written by the
 * ladder — never by the model.
 */
export interface NodeTestSpec {
  rung: TestRung;
  assertion: string;
  checkId?: string;
  status: 'untested' | 'running' | 'passed' | 'failed' | 'blocked_human';
  lastRunAt?: string;
  /** What the test actually saw on its last run (shown verbatim). */
  message?: string;
}

/** Why a node stopped (or did not stop) expanding — recorded, never implied. */
export type StopRule = 'R1_testability' | 'R2_decision_power' | 'R3_convergence' | 'R4_risk_gated' | 'budget_backstop';

export type ExpansionState = 'unexpanded' | 'expanded' | 'leaf' | 'stopped';

/** Real-world stakes: risk_gated nodes may not stop without a safety test. */
export type StakeLevel = 'normal' | 'risk_gated';

/** The L1 responsibility classes. Swarm roles map onto these 1:1. */
export type SubsystemClass =
  | 'POWER'
  | 'DRIVE'
  | 'STEERING'
  | 'CONTROL_LINK'
  | 'SENSING'
  | 'BRAIN'
  | 'STRUCTURE'
  | 'SAFETY'
  | 'OUTPUT'
  | 'OTHER';

/** Planning labels for the execution swarm — ownership, not a new runtime. */
export type SwarmRole = 'hardware-swarm' | 'firmware-swarm' | 'web-swarm' | 'mechanics-swarm';

export interface SwarmAssignment {
  role: SwarmRole;
  /** The subtree root (an L1 subsystem node id). */
  subtreeRootId: string;
  nodeIds: string[];
  /** How the role ran: sequential is the default and always honest. */
  execution: 'sequential';
  /** Per-role model override actually in effect (`null` = shared main model or none). */
  modelId: string | null;
  completed: boolean;
  completedAt: string | null;
  /** What the role reported when it finished its subtree. */
  summary?: string;
}

/** What the fresh-context reviewer may return. It never edits — FAIL/ESCALATE carry proposals/questions only. */
export type ReviewerVerdict = 'PASS' | 'FAIL' | 'ESCALATE';

export interface ReviewerFinding {
  /** Short machine-ish id, stable per finding kind + subject. */
  id: string;
  severity: 'blocking' | 'advisory';
  summary: string;
  /** Evidence: which node/test/artifact the finding is about. */
  subjectNodeId?: string;
  proposal?: string;
}

export interface ReviewerRecord {
  verdict: ReviewerVerdict;
  findings: ReviewerFinding[];
  /** ESCALATE carries the question for the human; FAIL carries proposals. */
  question?: string;
  /** `llm` = the configured review model answered; `rules` = the deterministic fallback. */
  reviewedBy: 'llm' | 'rules';
  modelId?: string | null;
  at: string;
}

/**
 * The idea graph itself — the decomposition half of Everflow. Persisted on
 * the project (it IS state, not a projection: expanding it changes what the
 * build does next), but rendered by materialising its nodes into the same
 * `EverflowGraph` the UI already draws. The build never depends on the
 * rendering; breaking the rendered graph can never break the build.
 */
export interface IdeaGraphState {
  /** The L0 intent — always the everflow intent node (`ev-intent`). */
  rootId: string;
  /** subsystem / test_result / review nodes created by the idea-graph loop. */
  nodes: EverflowNode[];
  edges: EverflowEdge[];
  /** Where the loop is — informational, the loop itself is bounded per move. */
  phase: 'idle' | 'expanding' | 'testing' | 'reviewing' | 'swarming' | 'done';
  /** BACKSTOP: total expansions performed. Trips an ask; never the normal finish. */
  expansions: number;
  /** R3: expansions that added no new edge into artifacts/tests/decisions. */
  deadExpansions: number;
  /** R3: whole-graph expansion pause (with a filed review ask). */
  expansionPaused: boolean;
  pausedReason: string | null;
  reviewer: ReviewerRecord | null;
  swarms: SwarmAssignment[] | null;
}

/**
 * The completion contract of a single node. The criterion is human language;
 * `kind` selects the deterministic check the evaluator runs against the
 * project state — goals are judged by code, never by the model's mood.
 */
export interface NodeGoal {
  /** What "done" means for this node, in human language. */
  criterion: string;
  /** Which deterministic check evaluates this goal. */
  kind:
    | 'artifact_exists'
    | 'validation_clean'
    | 'behaviour_proven'
    | 'human_confirmed'
    | 'evidence_attached'
    | 'doubt_answered'
    | 'requirement_covered'
    /** Idea graph: every leaf in the subtree has a run (passing or parked) test. */
    | 'subtree_tested'
    | 'custom';
  /** Evaluator's current verdict (materialise declares `open`; evaluate decides). */
  state: 'open' | 'in_progress' | 'satisfied' | 'blocked_human' | 'waived';
  /** Deterministic check identifier (assertion id, check id, file path…). */
  checkId?: string;
  /** Node id of the evidence that satisfied the goal, when any. */
  satisfiedBy?: string;
  note?: string;
}

export interface EverflowNode {
  id: string;
  kind: EverflowNodeKind;
  label: string;
  content: string;
  status: EverflowNodeStatus;
  /** Calibrated 0..1, or null when not yet assessed. */
  confidence: number | null;
  owner: 'ai' | 'human' | 'shared';
  goal: NodeGoal;
  /** Graph ↔ workspace files: the file this node lives in, when it has one. */
  file?: { path: string; anchor?: string } | null;
  /** Internal reference (component id, issue id, check id, assertion id…). */
  ref?: string;
  source: {
    origin: 'intake' | 'pipeline' | 'human' | 'continuation' | 'research' | 'expansion' | 'ladder' | 'reviewer' | 'swarm';
    stage?: string;
    revision?: number;
  };
  /* --- Idea graph fields (present on subsystem/test_result/review nodes) --- */
  /** Depth: the intent is level 0, its L1 subsystems level 1, and so on. */
  level?: number;
  /** Parent subsystem / intent node id, when the node is part of a subtree. */
  parentId?: string | null;
  /** The attached test this node must pass before it counts as done. */
  testSpec?: NodeTestSpec | null;
  /** Lifecycle of the expansion move for this node. */
  expansionState?: ExpansionState;
  /** How many targeted repairs this node needed (iteration history, kept visible). */
  repairCount?: number;
  /** Risk-gated nodes (power chains, actuators near humans, radio) may not stop without a safety test. */
  stakes?: StakeLevel;
  /** The L1 responsibility this node belongs to (denormalised for the UI/swarm). */
  subsystemClass?: SubsystemClass;
  /** Swarm role owning this node's subtree, once assigned. */
  swarmRole?: SwarmRole;
  /** Which stop rule decided this node's expansion fate (with the recorded reason). */
  stopRule?: StopRule;
  stopReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EverflowGraph {
  projectId: string;
  nodes: EverflowNode[];
  edges: EverflowEdge[];
  updatedAt: string;
}

/* ------------------------------------------------------------------------- */
/* Intake doubt session                                                       */
/* ------------------------------------------------------------------------- */

/** Who owns the answer. `ai` = technical call, recorded and appealable. */
export type DoubtDecider = 'human' | 'ai' | 'ai_with_veto';

export type DoubtStatus = 'open' | 'answered' | 'assumed' | 'resolved_ai';

export interface ProjectDoubt {
  id: string;
  question: string;
  /** Why this matters — the consequence of guessing wrong. */
  consequence: string;
  decider: DoubtDecider;
  /** Blocking doubts gate the Build button (soft gate: skipping records an assumption). */
  blocking: boolean;
  options: string[];
  /** Whether the intake agent knows that multiple options may coexist. */
  allowMultiple?: boolean;
  proposedDefault: string | null;
  /** The AI's confidence that the default is right, 0..1. */
  confidence: number;
  status: DoubtStatus;
  answer: {
    /** Human-readable answer kept for backwards-compatible project records. */
    value: string;
    /** Concrete choices selected when the user selected more than one option. */
    selectedOptions?: string[];
    via: 'human' | 'ai_default' | 'skipped';
    at: string;
  } | null;
  /** Graph node this doubt resolves to, once the graph is materialised. */
  nodeId?: string;
  createdAt: string;
}

/* ------------------------------------------------------------------------- */
/* Human channel — two directions                                             */
/* ------------------------------------------------------------------------- */

/**
 * `ai_to_human`  — column one: the agent needs something only a human can give
 *                  (confirmation, a choice, a real-world test, context).
 * `human_to_ai`  — column two: the human has information the agent cannot have
 *                  (ideas, corrections, resources, lived context).
 */
export type HumanTaskDirection = 'ai_to_human' | 'human_to_ai';

export type HumanTaskType =
  // AI → human
  | 'verify'
  | 'choose'
  | 'test'
  | 'review'
  | 'context'
  // human → AI
  | 'note'
  | 'idea'
  | 'correction'
  | 'resource'
  /** Mid-thought steering. Tier 1 (default): persisted, folded in next pass. */
  | 'steer';

export type ResponseShape = 'boolean' | 'choice' | 'text' | 'measurement';

export type HumanTaskStatus = 'open' | 'answered' | 'processed' | 'deferred' | 'expired';

export interface HumanTask {
  id: string;
  direction: HumanTaskDirection;
  type: HumanTaskType;
  title: string;
  body: string;
  asks: {
    shape: ResponseShape;
    options?: string[];
    /** Options that count as a positive/confirming answer (boolean tasks). */
    positiveOptions?: string[];
  };
  /** Graph nodes this task works on. */
  linkedNodeIds: string[];
  /** Where the human should look while answering. */
  lookAt?: { kind: 'node' | 'file' | 'sim' | 'quality' | 'project'; ref: string; label: string } | null;
  priority: 'low' | 'medium' | 'high';
  status: HumanTaskStatus;
  response: { value: string; note?: string; at: string } | null;
  /** What the agent does if this is never answered — it never blocks. */
  defaultOnExpiry: 'assume' | 'defer' | 'halt';
  assumptionIfSkipped: string | null;
  source: 'ai' | 'human' | 'intake';
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* ------------------------------------------------------------------------- */

export interface GoalEvaluation {
  nodeId: string;
  kind: EverflowNodeKind;
  label: string;
  goal: NodeGoal;
  satisfied: boolean;
  /** What the evaluator saw — shown verbatim in the UI. */
  evidence: string;
  /** True when the node is dangling: unmet goal, no task, no next action. */
  openEnd: boolean;
  openEndReason?: string;
}

export type NextActionKind = 'run_fix' | 'ask_human' | 'verify_sim' | 'integrate_input' | 'none';

export interface NextAction {
  kind: NextActionKind;
  nodeId?: string;
  description: string;
}

export interface EverflowEvaluation {
  at: string;
  pass: number;
  totals: {
    nodes: number;
    goalsTotal: number;
    goalsSatisfied: number;
    goalsOpen: number;
    goalsBlockedHuman: number;
    goalsWaived: number;
    openEnds: number;
    aiTasksOpen: number;
    humanTasksOpen: number;
  };
  /** 0..1 over non-waived goals. */
  completion: number;
  /** True when every non-waived goal is satisfied and nothing is dangling. */
  done: boolean;
  /** True when the only remaining work is owned by a human. */
  blockedOnHuman: boolean;
  results: GoalEvaluation[];
  nextActions: NextAction[];
  /** The rendered global project document (the context bundle). */
  brief: string;
}

/* ------------------------------------------------------------------------- */
/* Project-level state                                                        */
/* ------------------------------------------------------------------------- */

export interface EverflowState {
  /** Last materialised graph (persisted for the UI; the API can re-materialise live). */
  graph: EverflowGraph | null;
  /** Last evaluation of that graph. */
  evaluation: EverflowEvaluation | null;
  /** How many continuation passes have run. */
  pass: number;
  /**
   * The act phase — the loop's own engineering moves (revalidate a drifted
   * design, reprove behaviour in the emulator, run a targeted fix pass).
   * Optional so pre-act-phase persisted documents stay valid; the first new
   * pass seeds the bookkeeping from the state it finds.
   */
  actions?: EverflowActionState | null;
}

/* ------------------------------------------------------------------------- */
/* The act phase — moves the loop runs itself, before it asks a human         */
/* ------------------------------------------------------------------------- */

/**
 * What the loop can DO on its own between evaluating the goals and planning
 * asks. Every move is deterministic-first, fingerprint-guarded (it never
 * re-runs on an unchanged design), budgeted, and recorded — a guess is never
 * a silent fact, and a repair is never a silent self-modification: it freezes
 * a revision like every other design change.
 */
export type EverflowMoveKind =
  /** The design drifted since the validation the loop last saw → re-run the validator. */
  | 'revalidate'
  /** Unmet behavioural promises + firmware/spec drift → re-run the emulator before asking a human. */
  | 'reprove'
  /** Unmet `validation_clean` → the loop's own targeted fix pass (deterministic, budgeted). */
  | 'repair';

/** One executed (or deliberately skipped) move, for the UI and the audit trail. */
export interface EverflowActionRecord {
  id: string;
  move: EverflowMoveKind;
  /** Continuation pass the move ran in. */
  pass: number;
  at: string;
  /** Why the move was chosen — grounded in the evaluation, never in a mood. */
  trigger: string;
  outcome: 'changed' | 'no_change' | 'skipped' | 'failed';
  /** What happened, in one human line. */
  summary: string;
  /** Design fingerprint the move saw (the idempotency guard). */
  fingerprint?: string;
  /** Revision frozen by the move, when it changed the design. */
  revision?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Act-phase bookkeeping. The fingerprints are what make the moves idempotent:
 * a move only runs when the content it reads has actually changed since the
 * loop last observed it, so repeated passes over a stable project do nothing.
 */
export interface EverflowActionState {
  /** Design fingerprint at the last validation the loop observed. */
  lastValidatedFingerprint: string | null;
  /** Firmware+spec fingerprint at the last behavioural evaluation the loop observed. */
  lastReprovedFingerprint: string | null;
  /** Issue signature the last repair attempt saw — never retried unchanged. */
  lastRepairSignature: string | null;
  /** Repairs executed against this project (bounded by WIREUP_EVERFLOW_MAX_REPAIRS). */
  repairsUsed: number;
  /** Behavioural re-runs executed (bounded by WIREUP_EVERFLOW_MAX_REPROOFS). */
  reproofsUsed: number;
  /** The audit trail, newest last, capped. */
  history: EverflowActionRecord[];
  lastRunAt: string | null;
}

/* ------------------------------------------------------------------------- */
/* Research — the agent's docs/web check tool                                 */
/* ------------------------------------------------------------------------- */

/** Where a research finding came from. */
export type ResearchSource = 'catalog' | 'corpus' | 'web';

/**
 * The result of the agent checking documentation (catalog, the bundled docs
 * corpus, or the live web) for a graph node it is not confident about.
 * Findings are EVIDENCE with a citation — they inform, they never silently
 * satisfy a goal, and web findings are always flagged for human review.
 */
export interface ResearchFinding {
  id: string;
  /** Graph node this research was performed for. */
  nodeId: string;
  /** What the agent wanted to know. */
  question: string;
  source: ResearchSource;
  /** Human-readable citation, e.g. "Raspberry Pi 5 — official specs". */
  title: string;
  url: string | null;
  /** The facts found, verbatim, for the record. */
  facts: string[];
  /** 0..1 — web findings are capped until a human confirms. */
  confidence: number;
  /** True when the human should still verify before this is trusted. */
  needsHumanCheck: boolean;
  at: string;
}

/**
 * The expanded brief — the messy prompt (often a voice transcription)
 * normalised into the global project document the agent works from.
 */
export interface ExpandedBrief {
  /** Rendered global project document (folded into the pipeline prompt). */
  text: string;
  structured: {
    goal: string;
    platform: string | null;
    components: { name: string; quantity: number; role: string }[];
    behaviours: string[];
    assumptions: string[];
    openQuestions: string[];
  };
  source: 'llm' | 'deterministic';
  at: string;
}
