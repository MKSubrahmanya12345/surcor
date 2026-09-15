/**
 * Idea graph — expansion + the intelligent stopper.
 *
 * The prompt becomes the L0 intent; expansion lays down Level-1 subsystems
 * ("responsibilities", not parts), then each node may spawn one more level.
 * Expansion is a MOVE inside the existing continuation pass: persisted,
 * idempotent, one event per expansion, bounded by a backstop budget that
 * files an ask when it trips (it is never the normal way the graph finishes).
 *
 * THE STOPPER — a node is a leaf when it is DONE, not when it is small.
 * Four rules, evaluated in order, the reason recorded on the node:
 *
 *   R1 testability floor (hard): a node may only become a leaf when it has
 *      BOTH a concrete realization (catalog part / artifact / decided
 *      decision with evidence) AND a test it can actually run. Not both ⇒
 *      it expands again.
 *   R2 decision-power (saturation): one cheap model call — "would any child
 *      change a downstream action (part, pin, wire, code, test)?" If no ⇒
 *      stop as strategic. With no model: R2 is skipped; R1/R3/R4 still apply.
 *   R3 convergence: an expansion that adds no new edge into
 *      artifacts/tests/decisions is dead; two dead expansions anywhere pause
 *      expansion and file a review ask.
 *   R4 risk-gated (anti-stop): stakes='risk_gated' nodes (power chains,
 *      actuators, radio) are FORBIDDEN from stopping before they contain a
 *      concrete safety test.
 *
 * Deterministic fallback: a hand-written Level-1 template per project class,
 * and state-driven Level-2+ children derived from the ACTUAL pipeline state
 * (real selected parts, real assertions — nothing invented), so the graph
 * completes with zero model calls. The model refines; it never owns the tree.
 */

import type {
  EverflowNode,
  IdeaGraphState,
  NodeGoal,
  NodeTestSpec,
  StakeLevel,
  StopRule,
  SubsystemClass,
  TestRung,
} from '@/types/everflow';
import type { ProjectState } from '@/types/project';

import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';

/* ------------------------------------------------------------------------- */
/* Project class + the Level-1 templates                                      */
/* ------------------------------------------------------------------------- */

export type ProjectClass = 'vehicle' | 'robot' | 'home' | 'instrument' | 'generic';

const CLASS_PATTERNS: { cls: ProjectClass; pattern: RegExp }[] = [
  { cls: 'vehicle', pattern: /\b(rc car|rc truck|car|rover|cart|buggy|tank|boat|rc plane|rc boat|vehicle|drive\b.*motors|go-?kart|skateboard|bike)\b/i },
  { cls: 'robot', pattern: /\b(robot|robotic|arm|manipulator|quadruped|hexapod|maze solver|line follower|obstacle avoid)\w*/i },
  { cls: 'instrument', pattern: /\b(meter|gauge|logger|monitor|instrument|detector|sensor station|weather station|thermometer|anemometer|scale)\b/i },
  { cls: 'home', pattern: /\b(smart home|home automation|lights?|lamp|blind|curtain|doorbell|door lock|thermostat|irrigation|watering|feeder)\b/i },
];

/** The cheapest honest classification: keywords the prompt actually contains. */
export function classifyProject(prompt: string): ProjectClass {
  for (const { cls, pattern } of CLASS_PATTERNS) {
    if (pattern.test(prompt)) return cls;
  }
  return 'generic';
}

interface ChildSeed {
  label: string;
  subsystemClass: SubsystemClass;
  goalCriterion: string;
  stakes: StakeLevel;
  testRung: TestRung;
  testAssertion: string;
  content: string;
}

/**
 * The hand-written L1 template per project class — the deterministic fallback
 * that makes expansion work with no model at all. Each seed is a
 * RESPONSIBILITY with a completion goal and a test slot, not a part.
 */
const L1_TEMPLATES: Record<ProjectClass, ChildSeed[]> = {
  vehicle: [
    { label: 'POWER', subsystemClass: 'POWER', stakes: 'risk_gated', goalCriterion: 'A supply chain that drives every load for the runtime the brief implies, with a cutoff.', testRung: 'electrical', testAssertion: 'Power budget check passes for the selected supply.', content: 'Battery, regulation, distribution and a low-voltage cutoff.' },
    { label: 'DRIVE', subsystemClass: 'DRIVE', stakes: 'risk_gated', goalCriterion: 'Motors plus a driver from the catalog that move the vehicle at the speed the brief implies.', testRung: 'catalog', testAssertion: 'Every drive part exists in the catalog and the driver rating covers the motor current.', content: 'Motors, motor driver, gearing/mounting notes.' },
    { label: 'STEERING', subsystemClass: 'STEERING', stakes: 'normal', goalCriterion: 'A steering scheme (differential vs servo) decided with evidence.', testRung: 'catalog', testAssertion: 'The steering decision names its evidence (parts or firmware differential mixing).', content: 'Differential drive vs servo steering — a real decision node.' },
    { label: 'CONTROL LINK', subsystemClass: 'CONTROL_LINK', stakes: 'normal', goalCriterion: 'Operator commands reach the vehicle and are acknowledged.', testRung: 'behavioral', testAssertion: 'The firmware parses the commanded drive channels.', content: 'How commands get in: BT serial, web/serial relay, or WiFi.' },
    { label: 'SENSING', subsystemClass: 'SENSING', stakes: 'normal', goalCriterion: 'The vehicle senses what the brief promises (obstacles, distance, telemetry).', testRung: 'behavioral', testAssertion: 'The sensor readout is asserted in the behavioural evaluator.', content: 'Obstacle detection plus any telemetry.' },
    { label: 'BRAIN', subsystemClass: 'BRAIN', stakes: 'normal', goalCriterion: 'A controller chosen on purpose — it constrains pins, libraries and power.', testRung: 'compile', testAssertion: 'The generated firmware compiles against the controller pin map.', content: 'Controller choice and its consequences.' },
    { label: 'STRUCTURE', subsystemClass: 'STRUCTURE', stakes: 'normal', goalCriterion: 'A chassis plan with a weight budget and wire routing that fits.', testRung: 'catalog', testAssertion: 'The build guide names the chassis/mounting steps.', content: 'Chassis, weight budget, wire routing (notes for MVP; CAD is gated).' },
    { label: 'SAFETY', subsystemClass: 'SAFETY', stakes: 'risk_gated', goalCriterion: 'Runaway stop and low-voltage cutoff are proven by a test, not promised.', testRung: 'behavioral', testAssertion: 'A safety assertion (obstacle stop / kill switch / cutoff) passes.', content: 'Runaway stop, low-voltage cutoff, kill switch.' },
  ],
  robot: [
    { label: 'POWER', subsystemClass: 'POWER', stakes: 'risk_gated', goalCriterion: 'A supply chain that covers stall currents with headroom and a cutoff.', testRung: 'electrical', testAssertion: 'Power budget check passes for the selected supply.', content: 'Battery, regulation, distribution, cutoff.' },
    { label: 'ACTUATORS', subsystemClass: 'DRIVE', stakes: 'risk_gated', goalCriterion: 'Every actuator (drive, arm, gripper) has a driver rated for it.', testRung: 'catalog', testAssertion: 'Every actuator part exists and its driver is rated for the load.', content: 'Motors/servos/arms with their drivers.' },
    { label: 'SENSING', subsystemClass: 'SENSING', stakes: 'normal', goalCriterion: 'The robot perceives what its task demands.', testRung: 'behavioral', testAssertion: 'Sensor assertions pass in the behavioural evaluator.', content: 'Distance, line, attitude — task-dependent.' },
    { label: 'BRAIN', subsystemClass: 'BRAIN', stakes: 'normal', goalCriterion: 'A controller chosen on purpose; the firmware compiles against it.', testRung: 'compile', testAssertion: 'The generated firmware compiles against the controller pin map.', content: 'Controller choice and its consequences.' },
    { label: 'CONTROL LINK', subsystemClass: 'CONTROL_LINK', stakes: 'normal', goalCriterion: 'Commands/telemetry reach the operator.', testRung: 'behavioral', testAssertion: 'The command set parses in the firmware.', content: 'Link, protocol, command set.' },
    { label: 'STRUCTURE', subsystemClass: 'STRUCTURE', stakes: 'normal', goalCriterion: 'A body plan with weight and clearance that fits the actuators.', testRung: 'catalog', testAssertion: 'The build guide names the assembly steps.', content: 'Chassis, joints, mounting (notes for MVP).' },
    { label: 'SAFETY', subsystemClass: 'SAFETY', stakes: 'risk_gated', goalCriterion: 'E-stop and runaway behaviour proven by a test.', testRung: 'behavioral', testAssertion: 'A safety assertion (estop / stall / runaway) passes.', content: 'E-stop, stall detection, runaway stop.' },
  ],
  home: [
    { label: 'POWER', subsystemClass: 'POWER', stakes: 'risk_gated', goalCriterion: 'Mains-safe supply and switching with correct ratings.', testRung: 'electrical', testAssertion: 'Power budget and relay ratings check passes.', content: 'Supply, relays, isolation.' },
    { label: 'SENSING', subsystemClass: 'SENSING', stakes: 'normal', goalCriterion: 'The home state the brief promises is actually measured.', testRung: 'behavioral', testAssertion: 'Sensor assertions pass in the behavioural evaluator.', content: 'Environment, presence, doors — brief-dependent.' },
    { label: 'OUTPUT', subsystemClass: 'OUTPUT', stakes: 'normal', goalCriterion: 'Every promised output (light, pump, alarm) switches on command.', testRung: 'catalog', testAssertion: 'Each actuator exists and its driver/relay is rated.', content: 'Actuators and their drivers.' },
    { label: 'BRAIN', subsystemClass: 'BRAIN', stakes: 'normal', goalCriterion: 'A controller chosen on purpose; the firmware compiles against it.', testRung: 'compile', testAssertion: 'The generated firmware compiles against the controller pin map.', content: 'Controller choice and its consequences.' },
    { label: 'CONTROL LINK', subsystemClass: 'CONTROL_LINK', stakes: 'normal', goalCriterion: 'The user can control and observe it from where the brief says.', testRung: 'behavioral', testAssertion: 'The command set parses in the firmware.', content: 'App/web/serial link and command set.' },
    { label: 'SAFETY', subsystemClass: 'SAFETY', stakes: 'risk_gated', goalCriterion: 'Failure modes (stuck relay, sensor loss, flooding/overheat) are handled and tested.', testRung: 'behavioral', testAssertion: 'A safety assertion (failsafe / watchdog / interlock) passes.', content: 'Failsafes and interlocks.' },
  ],
  instrument: [
    { label: 'POWER', subsystemClass: 'POWER', stakes: 'risk_gated', goalCriterion: 'A quiet, correctly-rated supply for measurement accuracy.', testRung: 'electrical', testAssertion: 'Power budget check passes for the selected supply.', content: 'Supply, regulation, filtering.' },
    { label: 'SENSING', subsystemClass: 'SENSING', stakes: 'normal', goalCriterion: 'The measured quantity is captured at the promised range/resolution.', testRung: 'behavioral', testAssertion: 'Measurement assertions pass in the behavioural evaluator.', content: 'The measurement chain.' },
    { label: 'OUTPUT', subsystemClass: 'OUTPUT', stakes: 'normal', goalCriterion: 'Readings are shown/recorded where the brief says.', testRung: 'catalog', testAssertion: 'Display/log parts exist and are wired.', content: 'Display, logging, telemetry.' },
    { label: 'BRAIN', subsystemClass: 'BRAIN', stakes: 'normal', goalCriterion: 'A controller chosen on purpose; the firmware compiles against it.', testRung: 'compile', testAssertion: 'The generated firmware compiles against the controller pin map.', content: 'Controller choice and its consequences.' },
    { label: 'SAFETY', subsystemClass: 'SAFETY', stakes: 'risk_gated', goalCriterion: 'Out-of-range and sensor-failure behaviour is handled and tested.', testRung: 'behavioral', testAssertion: 'A safety assertion (range guard / fail indicator) passes.', content: 'Range guards and failure indication.' },
  ],
  generic: [
    { label: 'POWER', subsystemClass: 'POWER', stakes: 'risk_gated', goalCriterion: 'A supply that covers every load with headroom.', testRung: 'electrical', testAssertion: 'Power budget check passes for the selected supply.', content: 'Supply, regulation, distribution.' },
    { label: 'INPUT / SENSING', subsystemClass: 'SENSING', stakes: 'normal', goalCriterion: 'Every input the brief names is read and asserted.', testRung: 'behavioral', testAssertion: 'Input assertions pass in the behavioural evaluator.', content: 'Sensors and user inputs.' },
    { label: 'OUTPUT / ACTUATION', subsystemClass: 'OUTPUT', stakes: 'normal', goalCriterion: 'Every output the brief names is driven by a rated part.', testRung: 'catalog', testAssertion: 'Each output part exists and is wired.', content: 'Actuators, indicators, sound.' },
    { label: 'BRAIN', subsystemClass: 'BRAIN', stakes: 'normal', goalCriterion: 'A controller chosen on purpose; the firmware compiles against it.', testRung: 'compile', testAssertion: 'The generated firmware compiles against the controller pin map.', content: 'Controller choice and its consequences.' },
    { label: 'CONTROL LINK', subsystemClass: 'CONTROL_LINK', stakes: 'normal', goalCriterion: 'Control/telemetry reach the operator as promised.', testRung: 'behavioral', testAssertion: 'The command set parses in the firmware.', content: 'Link and command set.' },
    { label: 'SAFETY', subsystemClass: 'SAFETY', stakes: 'risk_gated', goalCriterion: 'The failure modes that could cost something real are handled and tested.', testRung: 'behavioral', testAssertion: 'A safety assertion passes in the behavioural evaluator.', content: 'Failsafes appropriate to the build.' },
  ],
};

export function levelOneSeeds(projectClass: ProjectClass): ChildSeed[] {
  return L1_TEMPLATES[projectClass];
}

/* ------------------------------------------------------------------------- */
/* Children — the model seam + the deterministic derivation                    */
/* ------------------------------------------------------------------------- */

/** What an expansion proposes: one level of children for one node. */
export interface ProposedChild {
  label: string;
  content: string;
  goalCriterion: string;
  subsystemClass: SubsystemClass;
  stakes: StakeLevel;
  testSpec: Pick<NodeTestSpec, 'rung' | 'assertion'>;
}

/**
 * The model seam. Production wires Bedrock behind this; tests inject canned
 * responses; with no model at all the deterministic path is complete.
 */
export interface ExpansionModel {
  /** One call: propose ONE level of children for ONE node. */
  proposeChildren(input: {
    node: EverflowNode;
    level: number;
    projectClass: ProjectClass;
    prompt: string;
    brief: string;
    existingLabels: string[];
  }): Promise<{ ok: true; children: ProposedChild[] } | { ok: false; error: string } | 'unavailable'>;
  /** R2 (one cheap call): would any child change a downstream action? `null` = skip R2. */
  decisionPower?(input: { node: EverflowNode; realization: string }): Promise<{ changes: boolean; reason: string } | null>;
}

/** Offline "model": always refuses, so the deterministic path proves itself. */
export const nullExpansionModel: ExpansionModel = {
  async proposeChildren() {
    return 'unavailable' as const;
  },
  async decisionPower() {
    return null;
  },
};

/** Map a component role to the subsystem that owns it. */
function subsystemForRole(role: string): SubsystemClass {
  switch (role) {
    case 'controller':
      return 'BRAIN';
    case 'communication':
      return 'CONTROL_LINK';
    case 'sensor':
    case 'input':
      return 'SENSING';
    case 'power':
      return 'POWER';
    case 'display':
      return 'OUTPUT';
    case 'motor':
    case 'motor_driver':
    case 'actuator':
    case 'driver':
      return 'DRIVE';
    default:
      return 'OTHER';
  }
}

function testSpecForSelection(role: string, name: string): Pick<NodeTestSpec, 'rung' | 'assertion'> {
  switch (role) {
    case 'power':
      return { rung: 'electrical', assertion: `${name} fits the power budget and voltage domains.` };
    case 'controller':
      return { rung: 'compile', assertion: `The firmware compiles against ${name}'s pin map.` };
    case 'sensor':
    case 'input':
      return { rung: 'behavioral', assertion: `${name}'s readout is asserted in the behavioural evaluator.` };
    case 'communication':
      return { rung: 'behavioral', assertion: `The command set that travels over ${name} parses in the firmware.` };
    case 'motor':
    case 'motor_driver':
    case 'actuator':
    case 'driver':
      return { rung: 'catalog', assertion: `${name} exists in the catalog and is driven by a part rated for it.` };
    default:
      return { rung: 'catalog', assertion: `${name} exists in the catalog and appears in the wiring/diagram.` };
  }
}

/**
 * Deterministic children from the ACTUAL pipeline state — the fallback that
 * needs no model and invents nothing: every child names a real selection, a
 * real artifact or a real assertion. For an L0 root with no pipeline state
 * yet, the class template provides the L1 skeleton (Phase A).
 */
export function deterministicChildren(state: ProjectState, node: EverflowNode, projectClass: ProjectClass): ProposedChild[] {
  const isRoot = node.level === 0 || node.kind === 'intent';
  if (isRoot) {
    return levelOneSeeds(projectClass).map((seed) => ({
      label: seed.label,
      content: seed.content,
      goalCriterion: seed.goalCriterion,
      subsystemClass: seed.subsystemClass,
      stakes: seed.stakes,
      testSpec: { rung: seed.testRung, assertion: seed.testAssertion },
    }));
  }

  const cls: SubsystemClass = node.subsystemClass ?? subsystemForRole(node.ref ?? '') ?? 'OTHER';
  const selections = state.components ?? [];
  const assertions = state.requirements?.behavioralSpec?.assertions ?? [];
  const children: ProposedChild[] = [];

  const own = (role: string): boolean => subsystemForRole(role) === cls;

  switch (cls) {
    case 'POWER': {
      for (const selection of selections.filter((entry) => entry.role === 'power' || entry.category === 'power')) {
        children.push({
          label: selection.name,
          content: `${selection.reason}${selection.quantity > 1 ? ` (×${selection.quantity})` : ''}`,
          goalCriterion: `${selection.name} is in the build and fits the budget.`,
          subsystemClass: 'POWER',
          stakes: 'risk_gated',
          testSpec: testSpecForSelection('power', selection.name),
        });
      }
      children.push({
        label: 'Budget & cutoff',
        content: 'Sustained vs stall load vs supply capability; a cutoff below the damage threshold.',
        goalCriterion: 'The power budget check passes and a cutoff is specified.',
        subsystemClass: 'POWER',
        stakes: 'risk_gated',
        testSpec: { rung: 'electrical', assertion: 'power.budget passes; a cutoff/low-voltage guard is documented.' },
      });
      break;
    }
    case 'DRIVE': {
      const parts = selections.filter((entry) => own(entry.role) || ['motor', 'motor_driver', 'actuator'].includes(entry.category));
      for (const selection of parts) {
        children.push({
          label: selection.name,
          content: `${selection.reason}${selection.quantity > 1 ? ` (×${selection.quantity})` : ''}`,
          goalCriterion: `${selection.name} is selected with a driver rated for it.`,
          subsystemClass: 'DRIVE',
          stakes: /driver|esc|bridge/i.test(selection.name) ? 'risk_gated' : 'normal',
          testSpec: testSpecForSelection(selection.role, selection.name),
        });
      }
      if (parts.length > 0) {
        children.push({
          label: 'Drive wiring & pins',
          content: 'PWM/DIR pins assigned conflict-free; wiring graph connects driver to motors and MCU.',
          goalCriterion: 'Drive pins are assigned and the wiring graph is conflict-free.',
          subsystemClass: 'DRIVE',
          stakes: 'normal',
          testSpec: { rung: 'catalog', assertion: 'pins.assignments and wiring.graph checks pass for the drive parts.' },
        });
      }
      break;
    }
    case 'SENSING': {
      for (const selection of selections.filter((entry) => own(entry.role))) {
        const assertion = assertions.find((entry) => new RegExp(selection.name.split(' ')[0], 'i').test(entry.title));
        children.push({
          label: selection.name,
          content: `${selection.reason}${selection.quantity > 1 ? ` (×${selection.quantity})` : ''}`,
          goalCriterion: `${selection.name} is read and its behaviour asserted.`,
          subsystemClass: 'SENSING',
          stakes: 'normal',
          testSpec: assertion
            ? { rung: 'behavioral', assertion: `Behavioural assertion "${assertion.title}" passes.`, }
            : testSpecForSelection(selection.role, selection.name),
        });
      }
      break;
    }
    case 'BRAIN': {
      const controller = selections.find((entry) => entry.role === 'controller') ?? (state.hardwarePlan?.controller ? { name: state.hardwarePlan.controller.name, reason: state.hardwarePlan.controller.reason } : null);
      if (controller) {
        children.push({
          label: controller.name,
          content: (controller as { reason?: string }).reason ?? 'The chosen controller.',
          goalCriterion: 'The controller decision has evidence and the firmware compiles against its pin map.',
          subsystemClass: 'BRAIN',
          stakes: 'normal',
          testSpec: { rung: 'compile', assertion: `code.compile passes for the ${controller.name} build.` },
        });
      }
      break;
    }
    case 'CONTROL_LINK': {
      for (const selection of selections.filter((entry) => own(entry.role))) {
        children.push({
          label: selection.name,
          content: selection.reason,
          goalCriterion: `${selection.name} is wired and reachable from the firmware.`,
          subsystemClass: 'CONTROL_LINK',
          stakes: /radio|wireless|wifi|bluetooth|antenna/i.test(selection.name) ? 'risk_gated' : 'normal',
          testSpec: testSpecForSelection(selection.role, selection.name),
        });
      }
      children.push({
        label: 'Command set',
        content: 'The operator commands the firmware must parse (derived from the software plan).',
        goalCriterion: 'Every planned command parses in the generated firmware.',
        subsystemClass: 'CONTROL_LINK',
        stakes: 'normal',
        testSpec: { rung: 'behavioral', assertion: 'The command-channel behavioural assertions pass.' },
      });
      break;
    }
    case 'OUTPUT': {
      for (const selection of selections.filter((entry) => own(entry.role) || ['display', 'actuator'].includes(entry.category))) {
        children.push({
          label: selection.name,
          content: selection.reason,
          goalCriterion: `${selection.name} switches/updates on command.`,
          subsystemClass: 'OUTPUT',
          stakes: /relay|solenoid|mains/i.test(selection.name) ? 'risk_gated' : 'normal',
          testSpec: testSpecForSelection(selection.role, selection.name),
        });
      }
      break;
    }
    case 'STEERING': {
      children.push({
        label: 'Steering decision',
        content: 'Differential (two motors) vs servo steering — decided with evidence and recorded as a decision.',
        goalCriterion: 'The steering scheme is decided with evidence attached.',
        subsystemClass: 'STEERING',
        stakes: 'normal',
        testSpec: { rung: 'catalog', assertion: 'The steering decision names its evidence (drive parts or firmware mixing).' },
      });
      break;
    }
    case 'STRUCTURE': {
      children.push({
        label: 'Chassis & mounting plan',
        content: 'Weight budget, mounting points and wire routing, written into the build guide.',
        goalCriterion: 'The build guide covers chassis/mounting/routing.',
        subsystemClass: 'STRUCTURE',
        stakes: 'normal',
        testSpec: { rung: 'catalog', assertion: 'instructions.completeness passes and the guide names the assembly steps.' },
      });
      break;
    }
    case 'SAFETY': {
      const safetyAssertions = assertions.filter((entry) => /stop|obstacle|kill|estop|cutoff|cut-off|watchdog|failsafe|fail|alarm|guard|limit|tamper/i.test(`${entry.title} ${entry.id}`));
      for (const assertion of safetyAssertions.slice(0, 3)) {
        children.push({
          label: `Safety test: ${assertion.title}`,
          content: `Assertion ${assertion.id} — the firmware must keep this promise.`,
          goalCriterion: `Behavioural assertion "${assertion.title}" passes.`,
          subsystemClass: 'SAFETY',
          stakes: 'risk_gated',
          testSpec: { rung: 'behavioral', assertion: `Behavioural assertion "${assertion.title}" passes.` },
        });
      }
      if (safetyAssertions.length === 0) {
        children.push({
          label: 'Failsafe review',
          content: 'No safety assertion was derived from the brief — name the failure mode that could cost something real and add its test.',
          goalCriterion: 'A concrete safety behaviour is specified and asserted.',
          subsystemClass: 'SAFETY',
          stakes: 'risk_gated',
          testSpec: { rung: 'human_verify', assertion: 'A human confirms the named failsafe behaviour on the bench/simulator.' },
        });
      }
      break;
    }
    default:
      break;
  }

  return children;
}

/* ------------------------------------------------------------------------- */
/* The stopper                                                                */
/* ------------------------------------------------------------------------- */

export interface StopDecision {
  stop: boolean;
  rule: StopRule | null;
  reason: string;
}

const SAFETY_PATTERN = /safety|cutoff|cut-off|kill|estop|e-stop|runaway|fuse|thermal|overcurrent|watchdog|failsafe|interlock/i;

/** Does this node have a concrete realization the system can act on? */
export function hasRealization(node: EverflowNode, state: ProjectState, edgesInto: Set<string>): boolean {
  // A catalog part or a compiled/wired artifact the node owns.
  if (node.ref && (state.components ?? []).some((selection) => selection.componentId === node.ref)) return true;
  if (node.file?.path && (state.artifacts.code?.files ?? []).some((file) => file.path === node.file?.path)) return true;
  if (node.kind === 'subsystem' && edgesInto.has(`${node.id}:artifact`)) return true;
  // A decided decision with evidence attached (decision nodes carry satisfied goals by construction).
  if (node.goal.kind === 'custom' && node.goal.state === 'satisfied' && node.goal.criterion.toLowerCase().includes('decided')) return true;
  if (node.stopReason?.includes('evidence')) return true;
  return false;
}

/** Does this node carry a test it can actually run (or that a human was asked to run)? */
export function hasRunnableTest(node: EverflowNode): boolean {
  const spec = node.testSpec;
  if (!spec || !spec.assertion) return false;
  if (spec.rung === 'human_verify') return Boolean(spec.checkId); // real only when the ask exists
  return true;
}

/** R4: risk-gated nodes need a CONCRETE SAFETY test before they may stop. */
export function hasSafetyTest(node: EverflowNode): boolean {
  const spec = node.testSpec;
  return Boolean(spec && SAFETY_PATTERN.test(spec.assertion));
}

/**
 * The four stop rules, in order, with the deciding rule recorded.
 * Pure: same node/state/edges in, same decision out.
 */
export function decideStop(node: EverflowNode, state: ProjectState, edgesInto: Set<string>, decisionPower: { changes: boolean; reason: string } | null): StopDecision {
  // R4 — the anti-stop: risk-gated nodes may not stop without a safety test.
  if (node.stakes === 'risk_gated' && !hasSafetyTest(node)) {
    return { stop: false, rule: 'R4_risk_gated', reason: 'Risk-gated node without a concrete safety test — it may not stop yet.' };
  }
  // R1 — the testability floor.
  const realization = hasRealization(node, state, edgesInto);
  const test = hasRunnableTest(node);
  if (!realization || !test) {
    const missing = [!realization ? 'a concrete realization' : null, !test ? 'a runnable test' : null].filter(Boolean).join(' and ');
    return { stop: false, rule: 'R1_testability', reason: `No ${missing} yet — the node expands again.` };
  }
  // R2 — the decision-power saturation stop (only when a model is wired).
  if (decisionPower) {
    if (!decisionPower.changes) {
      return { stop: true, rule: 'R2_decision_power', reason: `No child would change a downstream action — strategic stop. ${decisionPower.reason}` };
    }
    return { stop: false, rule: 'R2_decision_power', reason: `A child would still change a downstream action — expand. ${decisionPower.reason}` };
  }
  // Both R1 conditions hold and no model asked R2 → the node may be a leaf.
  return { stop: true, rule: 'R1_testability', reason: 'Has a concrete realization and a runnable test.' };
}

/* ------------------------------------------------------------------------- */
/* Idea graph state                                                           */
/* ------------------------------------------------------------------------- */

export function emptyIdeaGraphState(prompt: string): IdeaGraphState {
  return {
    rootId: 'ev-intent',
    nodes: [],
    edges: [],
    phase: 'idle',
    expansions: 0,
    deadExpansions: 0,
    expansionPaused: false,
    pausedReason: null,
    reviewer: null,
    swarms: null,
    ...(prompt ? {} : {}),
  };
}

function ideaNodeId(label: string, taken: Set<string>): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'node';
  let id = `ig-${slug}`;
  let n = 2;
  while (taken.has(id)) id = `ig-${slug}-${n++}`;
  return id;
}

function subsystemNode(partial: {
  id: string;
  label: string;
  content: string;
  level: number;
  parentId: string;
  goalCriterion: string;
  stakes: StakeLevel;
  subsystemClass: SubsystemClass;
  testSpec: Pick<NodeTestSpec, 'rung' | 'assertion'>;
  at: string;
  source?: 'expansion' | 'model' | 'template';
}): EverflowNode {
  return {
    id: partial.id,
    kind: 'subsystem',
    label: partial.label,
    content: partial.content,
    status: 'active',
    confidence: partial.source === 'model' ? 0.75 : 0.85,
    owner: 'ai',
    goal: {
      criterion: partial.goalCriterion,
      kind: 'subtree_tested',
      state: 'open',
    },
    file: null,
    source: { origin: 'continuation', stage: 'idea-graph' },
    level: partial.level,
    parentId: partial.parentId,
    testSpec: { ...partial.testSpec, status: 'untested' },
    expansionState: 'unexpanded',
    repairCount: 0,
    stakes: partial.stakes,
    subsystemClass: partial.subsystemClass,
    createdAt: partial.at,
    updatedAt: partial.at,
  };
}

/* ------------------------------------------------------------------------- */
/* The expansion move                                                         */
/* ------------------------------------------------------------------------- */

export interface ExpansionMoveResult {
  ideaGraph: IdeaGraphState;
  /** Events to append (one per expansion, one per stop decision). */
  events: {
    type: 'idea_graph_expansion';
    status: 'completed' | 'info' | 'failed';
    message: string;
    metadata: Record<string, unknown>;
  }[];
  /** Asks to file (backstop trip, R3 review pause). */
  newTasks: {
    type: 'review';
    title: string;
    body: string;
    linkedNodeId: string;
    defaultOnExpiry: 'defer';
    assumptionIfSkipped: string;
  }[];
  description: string[];
  moved: boolean;
}

export interface ExpansionMoveOptions {
  projectClass?: ProjectClass;
  maxExpansions: number;
  model?: ExpansionModel;
}

/** Edges into artifacts/tests/decisions, used by the realization + R3 checks. */
function artifactEdgeKeys(state: ProjectState, ideaGraph: IdeaGraphState): Set<string> {
  const keys = new Set<string>();
  const artifactIds = new Set<string>();
  for (const file of state.artifacts.code?.files ?? []) artifactIds.add(`ev-art-${file.path.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
  if (state.artifacts.diagram) artifactIds.add('ev-art-diagram');
  if (state.artifacts.libraries) artifactIds.add('ev-art-libraries');
  if (state.artifacts.instructions) artifactIds.add('ev-art-instructions');
  for (const node of ideaGraph.nodes) if (node.kind === 'test_result') artifactIds.add(node.id);
  for (const edge of ideaGraph.edges) {
    if (artifactIds.has(edge.to)) keys.add(`${edge.from}:artifact`);
  }
  return keys;
}

/**
 * Pick the next node to expand: breadth-first (lowest level first, insertion
 * order within a level). Only `unexpanded` nodes are eligible — a node whose
 * move already ran never silently runs again (idempotency contract).
 */
export function pickNodeToExpand(ideaGraph: IdeaGraphState): EverflowNode | null {
  const candidates = ideaGraph.nodes
    .filter((node) => node.kind === 'subsystem' && node.expansionState === 'unexpanded')
    .sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
  return candidates[0] ?? null;
}

/**
 * Run ONE expansion move (at most one node gains one level of children).
 * Pure with respect to `state`: same inputs, same result — the model is
 * injected, so offline runs are deterministic.
 */
export async function expansionMove(state: ProjectState, options: ExpansionMoveOptions): Promise<ExpansionMoveResult> {
  const at = nowIso();
  const ideaGraph: IdeaGraphState = state.ideaGraph ?? emptyIdeaGraphState(state.prompt);
  const result: ExpansionMoveResult = { ideaGraph, events: [], newTasks: [], description: [], moved: false };

  // The backstop: bounded work, stated out loud when it trips.
  if (ideaGraph.expansions >= options.maxExpansions) {
    const alreadyFiled = ideaGraph.pausedReason?.startsWith('backstop') ?? false;
    if (!alreadyFiled) {
      ideaGraph.pausedReason = `backstop: WIREUP_IDEA_GRAPH_MAX_EXPANSIONS (${options.maxExpansions}) reached — expansion paused.`;
      result.newTasks.push({
        type: 'review',
        title: `Expansion budget reached (${options.maxExpansions} expansions)`,
        body: `The idea graph hit its expansion backstop after ${ideaGraph.expansions} expansions. That budget exists to stop a runaway loop, not to finish the work — raise WIREUP_IDEA_GRAPH_MAX_EXPANSIONS or tell me which subtree to prioritise.`,
        linkedNodeId: 'ig-backstop',
        defaultOnExpiry: 'defer',
        assumptionIfSkipped: 'Expansion stays paused at the backstop; the tested leaves so far remain valid.',
      });
      result.events.push({
        type: 'idea_graph_expansion',
        status: 'info',
        message: `Expansion backstop reached (${ideaGraph.expansions}/${options.maxExpansions}) — paused and filed an ask. This budget is a guardrail, not a finish line.`,
        metadata: { kind: 'idea_graph.expansion', backstop: true, expansions: ideaGraph.expansions, max: options.maxExpansions },
      });
      result.description.push('Expansion paused at the backstop budget.');
      result.moved = true; // the pause + ask IS the move
    }
    return result;
  }

  if (ideaGraph.expansionPaused) {
    return result; // paused (R3/backstop) — a human/reviewer resumes it
  }

  // Ensure the L0→L1 skeleton exists at all (Phase A) before deeper work.
  if (ideaGraph.nodes.length === 0) {
    const projectClass = options.projectClass ?? classifyProject(state.prompt);
    const taken = new Set(ideaGraph.nodes.map((node) => node.id));
    const seeds = levelOneSeeds(projectClass);
    for (const seed of seeds) {
      const id = ideaNodeId(seed.label, taken);
      taken.add(id);
      ideaGraph.nodes.push(
        subsystemNode({
          id,
          label: seed.label,
          content: seed.content,
          level: 1,
          parentId: ideaGraph.rootId,
          goalCriterion: seed.goalCriterion,
          stakes: seed.stakes,
          subsystemClass: seed.subsystemClass,
          testSpec: { rung: seed.testRung, assertion: seed.testAssertion },
          at,
        }),
      );
      ideaGraph.edges.push({ id: `edge-${id}-part_of-intent`, from: id, to: ideaGraph.rootId, kind: 'part_of' });
    }
    ideaGraph.phase = 'expanding';
    result.ideaGraph = ideaGraph;
    result.events.push({
      type: 'idea_graph_expansion',
      status: 'completed',
      message: `Idea graph: "${projectClass}" skeleton laid down — ${seeds.length} Level-1 subsystem(s) (${seeds.map((seed) => seed.label).join(', ')}), each with a goal and an empty test slot.`,
      metadata: {
        kind: 'idea_graph.expansion',
        node: ideaGraph.rootId,
        level: 0,
        projectClass,
        children: seeds.map((seed) => seed.label),
        source: 'template',
      },
    });
    result.description.push(`Laid down the ${projectClass} L1 skeleton (${seeds.length} subsystems).`);
    result.moved = true;
    return result;
  }

  const node = pickNodeToExpand(ideaGraph);
  if (!node) {
    // Everything expanded or stopped: the move hands over to the ladder phase.
    if (ideaGraph.phase === 'expanding') {
      ideaGraph.phase = 'testing';
      result.description.push('Every subsystem decided — moving to per-node tests.');
      result.moved = true;
    }
    return result;
  }

  /* --- the stopper runs BEFORE expanding: four rules, in order ------------- */
  const projectClass = options.projectClass ?? classifyProject(state.prompt);
  const edgesInto = artifactEdgeKeys(state, ideaGraph);
  let decisionPower: { changes: boolean; reason: string } | null = null;
  if (options.model?.decisionPower) {
    try {
      decisionPower = await options.model.decisionPower({
        node,
        realization: node.ref
          ? `catalog part ${node.ref}`
          : node.testSpec
            ? `test: ${node.testSpec.assertion}`
            : node.content,
      });
    } catch {
      decisionPower = null; // R2 skipped honestly; R1/R3/R4 still apply
    }
  }
  const stop = decideStop(node, state, edgesInto, decisionPower);
  if (stop.stop) {
    node.expansionState = stop.rule === 'R2_decision_power' ? 'stopped' : 'leaf';
    node.stopRule = stop.rule ?? undefined;
    node.stopReason = stop.reason;
    node.updatedAt = at;
    result.ideaGraph = ideaGraph;
    result.events.push({
      type: 'idea_graph_expansion',
      status: 'completed',
      message: `Idea graph: "${node.label}" stops as ${node.expansionState === 'stopped' ? 'strategic' : 'a leaf'} — ${stop.rule}: ${stop.reason}`,
      metadata: {
        kind: 'idea_graph.expansion',
        node: node.id,
        label: node.label,
        level: node.level ?? 1,
        decision: 'stop',
        rule: stop.rule,
        reason: stop.reason,
      },
    });
    result.description.push(`${node.label} stops (${stop.rule}).`);
    result.moved = true;
    return result;
  }
  // Not stopping: record WHY it must expand (the R1/R4 reason stays visible).
  node.stopRule = stop.rule ?? undefined;
  node.stopReason = stop.reason;

  // --- propose children: model first, deterministic fallback always --------
  const taken = new Set(ideaGraph.nodes.map((node) => node.id));
  const existingLabels = ideaGraph.nodes.map((candidate) => candidate.label);
  const childLevel = (node.level ?? 1) + 1;
  const MAX_LEVEL = 4;

  let proposed: ProposedChild[] = [];
  let source: 'model' | 'template' | 'state' = 'state';
  let modelNote = '';

  if (childLevel <= MAX_LEVEL && options.model && options.model !== nullExpansionModel) {
    try {
      const answer = await options.model.proposeChildren({
        node,
        level: childLevel,
        projectClass,
        prompt: state.prompt,
        brief: state.everflow?.evaluation?.brief ?? state.prompt,
        existingLabels,
      });
      if (answer === 'unavailable') {
        modelNote = 'model unavailable — deterministic expansion used';
      } else if (answer.ok) {
        proposed = answer.children;
        source = 'model';
      } else {
        modelNote = `model call failed (${answer.error}) — deterministic expansion used`;
      }
    } catch (error) {
      modelNote = `model call threw (${error instanceof Error ? error.message : 'unknown'}) — deterministic expansion used`;
    }
  }

  if (proposed.length === 0) {
    if (childLevel <= MAX_LEVEL) {
      proposed = deterministicChildren(state, node, projectClass);
      source = node.level === 0 ? 'template' : 'state';
    }
    // Beyond MAX_LEVEL the graph stops honestly: depth is a consequence of
    // testability, not a target — and neither grows without bound.
  }

  // De-duplicate against existing labels (a model loves to restate siblings).
  const seenLabels = new Set(existingLabels.map((label) => label.toLowerCase()));
  const children = proposed.filter((child) => {
    const key = child.label.trim().toLowerCase();
    if (seenLabels.has(key)) return false;
    seenLabels.add(key);
    return true;
  });

  // --- R3 bookkeeping: did this expansion add anything real? ---------------
  const artifactEdgesBefore = artifactEdgeKeys(state, ideaGraph).size;
  const edgesBefore = ideaGraph.edges.length;

  const childNodes: EverflowNode[] = [];
  for (const child of children.slice(0, 6)) {
    const id = ideaNodeId(child.label, taken);
    taken.add(id);
    childNodes.push(
      subsystemNode({
        id,
        label: child.label,
        content: child.content,
        level: childLevel,
        parentId: node.id,
        goalCriterion: child.goalCriterion,
        stakes: child.stakes,
        subsystemClass: child.subsystemClass,
        testSpec: child.testSpec,
        at,
        ...(source === 'model' ? { source: 'model' as const } : {}),
      }),
    );
    ideaGraph.edges.push({ id: `edge-${id}-part_of-${node.id}`, from: id, to: node.id, kind: 'part_of' });
  }
  ideaGraph.nodes.push(...childNodes); // children are graph facts, not just event metadata

  const addedArtifactEdges = artifactEdgeKeys(state, ideaGraph).size - artifactEdgesBefore;
  const addedNewEdges = ideaGraph.edges.length - edgesBefore;
  const isDead = childNodes.length === 0 || (addedArtifactEdges === 0 && addedNewEdges === childNodes.length && childNodes.every((child) => child.stakes !== 'risk_gated'));

  node.expansionState = childNodes.length > 0 ? 'expanded' : 'stopped';
  node.stopRule = childNodes.length > 0 ? undefined : 'R3_convergence';
  node.stopReason = childNodes.length > 0 ? `${childNodes.length} child node(s) at level ${childLevel} (${source}${modelNote ? `; ${modelNote}` : ''}).` : 'Expansion produced nothing new.';
  node.updatedAt = at;
  ideaGraph.expansions += 1;

  if (isDead) {
    ideaGraph.deadExpansions += 1;
  }

  result.ideaGraph = ideaGraph;
  result.events.push({
    type: 'idea_graph_expansion',
    status: 'completed',
    message:
      childNodes.length > 0
        ? `Idea graph: "${node.label}" expanded to level ${childLevel} — ${childNodes.map((child) => child.label).join(', ')}.${modelNote ? ` (${modelNote})` : ''}`
        : `Idea graph: "${node.label}" expansion produced nothing new (dead expansion ${ideaGraph.deadExpansions}/2).`,
    metadata: {
      kind: 'idea_graph.expansion',
      node: node.id,
      level: childLevel,
      source,
      children: childNodes.map((child) => child.label),
      deadExpansion: isDead,
      deadExpansions: ideaGraph.deadExpansions,
      ...(modelNote ? { modelNote } : {}),
    },
  });
  result.description.push(`Expanded ${node.label} (level ${childLevel}, ${childNodes.length} children, source: ${source}).`);
  result.moved = true;

  // R3 — two dead expansions anywhere pause expansion and file a review ask.
  if (ideaGraph.deadExpansions >= 2 && !ideaGraph.expansionPaused) {
    ideaGraph.expansionPaused = true;
    ideaGraph.pausedReason = `R3_convergence: ${ideaGraph.deadExpansions} dead expansions — the graph stops restating itself.`;
    result.newTasks.push({
      type: 'review',
      title: 'Expansion is repeating itself — should I push deeper anyway?',
      body: `Two expansions added no new parts, tests or decisions (last one: "${node.label}"). Per the convergence rule I paused expansion. Tell me to push a specific subtree deeper, or accept the graph as-is.`,
      linkedNodeId: node.id,
      defaultOnExpiry: 'defer',
      assumptionIfSkipped: 'Expansion stays paused (R3); the tested leaves so far remain valid.',
    });
    result.events.push({
      type: 'idea_graph_expansion',
      status: 'info',
      message: 'Convergence rule (R3): two dead expansions — expansion paused and a review ask filed.',
      metadata: { kind: 'idea_graph.expansion', rule: 'R3_convergence', paused: true },
    });
  }

  return result;
}

/* ------------------------------------------------------------------------- */
/* Subtree helpers (shared with the ladder / reviewer / swarm)                 */
/* ------------------------------------------------------------------------- */

/** All idea-graph descendants of a node (excluding the node itself). */
export function subtreeOf(ideaGraph: IdeaGraphState, nodeId: string): EverflowNode[] {
  const byParent = new Map<string, EverflowNode[]>();
  for (const node of ideaGraph.nodes) {
    const parent = node.parentId ?? '';
    const list = byParent.get(parent) ?? [];
    list.push(node);
    byParent.set(parent, list);
  }
  const out: EverflowNode[] = [];
  const walk = (id: string): void => {
    for (const child of byParent.get(id) ?? []) {
      out.push(child);
      walk(child.id);
    }
  };
  walk(nodeId);
  return out;
}

/** Leaves of a subtree: nodes with no children. */
export function leavesOf(ideaGraph: IdeaGraphState, nodeId: string): EverflowNode[] {
  const subtree = subtreeOf(ideaGraph, nodeId);
  if (subtree.length === 0) {
    const self = ideaGraph.nodes.find((node) => node.id === nodeId);
    return self ? [self] : [];
  }
  const ids = new Set(subtree.map((node) => node.id));
  return subtree.filter((node) => !subtree.some((candidate) => candidate.parentId === node.id));
}

/** The deterministic subsystem goal judge: a subtree is tested when every leaf is. */
export function subtreeTestedVerdict(ideaGraph: IdeaGraphState, nodeId: string, openAskNodeIds: Set<string>): { state: NodeGoal['state']; evidence: string } {
  const leaves = leavesOf(ideaGraph, nodeId);
  if (leaves.length === 0) return { state: 'in_progress', evidence: 'No leaves yet — the subtree is still expanding.' };
  const untested = leaves.filter((leaf) => !leaf.testSpec || leaf.testSpec.status === 'untested');
  if (untested.length > 0) {
    return { state: 'in_progress', evidence: `${untested.length}/${leaves.length} leaf test(s) not run yet (first: ${untested[0].label}).` };
  }
  const failed = leaves.filter((leaf) => leaf.testSpec?.status === 'failed');
  if (failed.length > 0) {
    return { state: 'in_progress', evidence: `${failed.length} leaf test(s) failing (first: ${failed[0].label}).` };
  }
  const blocked = leaves.filter((leaf) => leaf.testSpec?.status === 'blocked_human');
  const unparkedBlocked = blocked.filter((leaf) => !openAskNodeIds.has(leaf.id));
  if (unparkedBlocked.length > 0) {
    return { state: 'in_progress', evidence: `${unparkedBlocked.length} human-verify test(s) without a filed ask (first: ${unparkedBlocked[0].label}).` };
  }
  const parts = [
    `${leaves.length} leaf test(s) passed`,
    ...(blocked.length > 0 ? [`${blocked.length} parked on a human ask`] : []),
  ];
  return { state: 'satisfied', evidence: `${parts.join(', ')}.` };
}

export { subsystemNode as makeSubsystemNode };
