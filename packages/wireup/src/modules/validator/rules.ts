/**
 * Deterministic validation rule engine.
 *
 * Every rule is evidence-based: it points at the exact pin, connection, file or
 * component instance that is wrong, and declares whether a non-LLM fix exists.
 * The model review (see `llm.ts`) is merged on top of these findings.
 */

import type { ComponentDefinition, ComponentSelection } from '@/types/component';
import type { Diagram } from '@/types/diagram';
import type { ProjectRequirements, ProjectState } from '@/types/project';
import type { ValidationCheck, ValidationDomain, ValidationIssue, ValidationIssueCode, ValidationSeverity } from '@/types/validation';
import type { PinAssignment, WiringPlan } from '@/types/wiring';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';

import {
  CodeArtifactSchema,
  ComponentSelectionSchema,
  DiagramSchema,
  InstructionsArtifactSchema,
  LibrariesArtifactSchema,
  PinAssignmentSchema,
  ProjectRequirementsSchema,
  WiringConnectionSchema,
} from '@/lib/validation/schema';
import { issueId } from '@/lib/validation/ids';

import { analyzeCoverage } from '@/modules/project-understanding';
import { dimsFor, isAxleJoint } from '@/modules/assembly-planner/heuristics';
import { isProvisional, provisionalVerification } from '@/modules/components/contracts';
import { braceBalance } from '@/modules/code-generator';
import { stripCodeComments } from '@/modules/code-generator/comments';
import { evaluateQuantityDelivery, shortfallSeverity } from './quantities';
import { constantName, pinLiteral } from '@/modules/code-generator/templates';
import { checkDiagramIntegrity, findMissingDiagramComponents } from '@/modules/diagram-generator';
import { detectConflicts } from '@/modules/wiring-planner/conflicts';
import { includeStatement } from '@/modules/code-generator/templates';
import { syncPinConstants } from '@/modules/code-generator';
import { ensureWireBegin, fixI2cAddressLiterals, pruneIncludes } from '@/modules/code-generator/hygiene';

/** Issue codes the deterministic fixer knows how to repair. */
export const AUTO_FIXABLE_CODES: ValidationIssueCode[] = [
  'gpio_conflict',
  'reserved_pin_used',
  'input_only_pin_driven',
  'analog_only_pin_driven',
  'uart_pin_used_as_gpio',
  'duplicate_pin_assignment',
  'capability_mismatch',
  'missing_ground',
  'missing_power',
  'motor_on_mcu_pin',
  'dangling_reference',
  'unknown_pin',
  'duplicate_connection',
  'floating_required_pin',
  'diagram_out_of_sync',
  'diagram_missing_component',
  'diagram_missing_connection',
  'code_pin_mismatch',
  'code_missing_include',
  'code_stray_include',
  'code_i2c_address_invalid',
  'code_missing_bus_init',
  'code_unbalanced_braces',
  'code_missing_setup_loop',
  'library_missing',
  'instructions_missing_section',
  'instructions_out_of_sync',
  'missing_component',
  'quantity_shortfall',
  'behavioral_assertion_failed',
  'assembly_unknown_part',
  'assembly_bad_placement',
];

export interface RuleContext {
  project: ProjectState;
  catalog: ComponentDefinition[];
  profile?: McuProfile;
}

/**
 * True when the generated firmware starts the given hardware serial port.
 * Using a UART pin as GPIO is only a defect while that port is in use, and the
 * evidence is the sketch text itself (`Serial.begin(...)`), not an assumption
 * baked into the rule.
 */
function opensSerialPort(project: ProjectState, portId: string): boolean {
  const pattern = new RegExp(`\\b${portId}\\s*\\.\\s*begin\\s*\\(`);
  return (project.artifacts.code?.files ?? []).some((file) => pattern.test(file.content));
}

interface IssueDraft {
  code: ValidationIssueCode;
  severity: ValidationSeverity;
  domain: ValidationDomain;
  message: string;
  details?: string;
  fixHint?: string;
  target?: ValidationIssue['target'];
}

export interface RuleEngineResult {
  checks: ValidationCheck[];
  issues: ValidationIssue[];
}

export function runRuleEngine(context: RuleContext): RuleEngineResult {
  const checks: ValidationCheck[] = [];
  const issues: ValidationIssue[] = [];
  const { project, catalog, profile } = context;

  const add = (checkId: string, draft: IssueDraft): ValidationIssue => {
    const issue: ValidationIssue = {
      id: issueId(),
      code: draft.code,
      severity: draft.severity,
      domain: draft.domain,
      message: draft.message,
      autoFixable: AUTO_FIXABLE_CODES.includes(draft.code),
      origin: 'rules',
      ...(draft.details ? { details: draft.details } : {}),
      ...(draft.fixHint ? { fixHint: draft.fixHint } : {}),
      ...(draft.target ? { target: draft.target } : {}),
    };
    issues.push(issue);
    return issue;
  };

  const finishCheck = (id: string, name: string, domain: ValidationDomain, from: number, okMessage: string): void => {
    const produced = issues.slice(from);
    checks.push({
      id,
      name,
      domain,
      status: produced.length === 0 ? 'passed' : produced.some((issue) => issue.severity === 'error') ? 'failed' : 'passed',
      message: produced.length === 0 ? okMessage : produced.map((issue) => issue.message).join(' | '),
      issueIds: produced.map((issue) => issue.id),
    });
  };

  /* 1. Structural schema validation ---------------------------------------- */
  let mark = issues.length;
  const requirementsCheck = ProjectRequirementsSchema.safeParse(project.requirements);
  if (project.requirements && !requirementsCheck.success) {
    add('structure', {
      code: 'schema_violation',
      severity: 'error',
      domain: 'requirements',
      message: 'Project requirements do not match the ProjectRequirements schema.',
      details: requirementsCheck.error.issues.slice(0, 5).map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '),
      fixHint: 'Re-run the requirements normalisation stage.',
      target: { artifact: 'requirements' },
    });
  }
  for (const selection of project.components) {
    const parsed = ComponentSelectionSchema.safeParse(selection);
    if (!parsed.success) {
      add('structure', {
        code: 'schema_violation',
        severity: 'error',
        domain: 'components',
        message: `Component selection "${selection.name ?? selection.componentId}" violates the schema.`,
        details: parsed.error.issues.slice(0, 4).map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '),
        target: { artifact: 'components', selectionId: selection.id },
      });
    }
  }
  for (const assignment of project.pinAssignments) {
    const parsed = PinAssignmentSchema.safeParse(assignment);
    if (!parsed.success) {
      add('structure', {
        code: 'schema_violation',
        severity: 'error',
        domain: 'pins',
        message: `Pin assignment ${assignment.id} violates the schema.`,
        details: parsed.error.issues.slice(0, 4).map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '),
        target: { artifact: 'pinAssignments', assignmentId: assignment.id },
      });
    }
  }
  for (const connection of project.wiring?.connections ?? []) {
    const parsed = WiringConnectionSchema.safeParse(connection);
    if (!parsed.success) {
      add('structure', {
        code: 'schema_violation',
        severity: 'error',
        domain: 'wiring',
        message: `Connection ${connection.id} violates the schema.`,
        details: parsed.error.issues.slice(0, 4).map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '),
        target: { artifact: 'wiring', connectionId: connection.id },
      });
    }
  }
  if (project.artifacts.code) {
    const parsed = CodeArtifactSchema.safeParse(project.artifacts.code);
    if (!parsed.success) {
      add('structure', {
        code: 'schema_violation',
        severity: 'error',
        domain: 'code',
        message: 'The code artifact violates the CodeArtifact schema.',
        details: parsed.error.issues.slice(0, 4).map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '),
        target: { artifact: 'code' },
      });
    }
  }
  finishCheck('structure.schema', 'Artifact schema validation', 'structure', mark, 'All artifacts match their schemas');

  /* 2. Requirements --------------------------------------------------------- */
  mark = issues.length;
  const requirements: ProjectRequirements | null = project.requirements;
  if (!requirements) {
    add('requirements', {
      code: 'empty_artifact',
      severity: 'error',
      domain: 'requirements',
      message: 'No project requirements were produced, so nothing downstream can be trusted.',
      fixHint: 'Re-run the project understanding stage.',
      target: { artifact: 'requirements' },
    });
  } else {
    if (!requirements.goal.trim()) {
      add('requirements', {
        code: 'empty_artifact',
        severity: 'error',
        domain: 'requirements',
        message: 'The requirements goal is empty.',
        target: { artifact: 'requirements' },
      });
    }
    /*
     * Evidence is what the design *does*, not what it says about itself.
     *
     * Two corpus entries used to make this check circular, and both had to go:
     *
     *   1. The firmware's machine-managed header restates the user's prompt and
     *      the extracted behaviours. The generator wrote the requirement into
     *      the file and the validator found it there, so a build with no line
     *      sensor at all scored a full 5/5 token match on "follow a black line
     *      on white floor". Comments are stripped so only real code counts.
     *   2. The build guide is written last, *from* the requirements — so it can
     *      only ever restate them. It is the same circularity one stage removed,
     *      and it was the last source still carrying every target token after
     *      the comments were stripped.
     *
     * What remains is independent: the parts chosen, why they were chosen, the
     * software architecture, and the wiring graph. None of those are derived
     * from the requirement text, so finding the requirement in them means the
     * design actually implements it.
     */
    const corpus = [
      ...project.components.map((selection) => `${selection.name} ${selection.reason} ${selection.notes ?? ''}`),
      ...(project.artifacts.code?.files ?? []).map((file) => stripCodeComments(file.content)),
      project.softwarePlan?.architecture ?? '',
      ...(project.softwarePlan?.modules ?? []).map((module) => `${module.name} ${module.responsibility}`),
      ...(project.wiring?.connections ?? []).map((connection) => connection.explanation),
    ].join('\n');

    const coverage = analyzeCoverage({ requirements, searchCorpus: corpus });
    for (const statement of coverage.uncovered.slice(0, 6)) {
      add('requirements', {
        code: 'requirement_uncovered',
        severity: 'warning',
        domain: 'requirements',
        message: `Requirement appears unimplemented: "${statement}"`,
        details: 'No component, wiring note, code or instruction text references the key terms of this requirement.',
        fixHint: 'Add the missing hardware/software behaviour or document why it is out of scope.',
        target: { artifact: 'requirements' },
      });
    }
  }
  finishCheck('requirements.coverage', 'Requirement coverage', 'requirements', mark, 'Every stated requirement is reflected in the design');

  /* 2b. Stated quantities vs delivered parts -------------------------------- */
  /*
   * Structural, not textual. Coverage asks whether the design's words resemble
   * the requirement's words; this asks how many of the part the brief counted
   * are actually in the bill of materials. That difference is the whole point:
   * "3 IR sensors" with zero sensors selected used to pass coverage on the
   * strength of prose alone, and no amount of wording can make zero into three.
   */
  mark = issues.length;
  for (const shortfall of evaluateQuantityDelivery({
    requirements,
    selections: project.components,
    catalog,
  })) {
    const severity = shortfallSeverity(shortfall);
    const where =
      shortfall.delivered === 0
        ? `the design contains none`
        : `only ${shortfall.delivered} of ${shortfall.expected} are in the design`;

    add('requirements', {
      code: 'quantity_shortfall',
      severity,
      domain: 'requirements',
      message: `The brief asks for ${shortfall.expected} ${shortfall.label} but ${where}.`,
      details:
        shortfall.delivered === 0
          ? 'No selected component matches this family, so the firmware has nothing to read from or drive.'
          : `${shortfall.missing} more ${shortfall.label} are needed to match the stated count.`,
      fixHint: shortfall.suggestedComponentName
        ? `Add ${shortfall.missing} × ${shortfall.suggestedComponentName} from the catalog and re-derive pins, wiring and firmware.`
        : 'Add the missing hardware or record the reduced count as an explicit scope decision.',
      target: {
        artifact: 'components',
        ...(shortfall.suggestedComponentId ? { componentId: shortfall.suggestedComponentId } : {}),
      },
    });
  }
  finishCheck(
    'requirements.quantities',
    'Stated quantities delivered',
    'requirements',
    mark,
    'Every quantity the brief counted is present in the design',
  );

  /* 3. Components ----------------------------------------------------------- */
  mark = issues.length;
  if (project.components.length === 0) {
    add('components', {
      code: 'empty_artifact',
      severity: 'error',
      domain: 'components',
      message: 'No components were selected.',
      target: { artifact: 'components' },
    });
  }

  const controller = project.components.find((selection) => selection.role === 'controller');
  if (!controller) {
    add('components', {
      code: 'missing_controller',
      severity: 'error',
      domain: 'components',
      message: 'The bill of materials contains no microcontroller, so the firmware has nothing to run on.',
      fixHint: 'Add a controller that satisfies the platform and communication requirements.',
      target: { artifact: 'components' },
    });
  }

  const instanceIds = new Set<string>();
  for (const selection of project.components) {
    if (!catalog.some((component) => component.id === selection.componentId)) {
      add('components', {
        code: 'unknown_component',
        severity: 'error',
        domain: 'components',
        message: `Component "${selection.componentId}" is not in the component database.`,
        details: selection.name !== selection.componentId ? `Listed as "${selection.name}".` : undefined,
        fixHint: 'Replace it with the closest catalog part.',
        target: { artifact: 'components', componentId: selection.componentId, selectionId: selection.id },
      });
    }
    if (selection.source === 'model') {
      add('components', {
        code: 'invented_component',
        severity: 'info',
        domain: 'components',
        message: `"${selection.name}" was matched from model text ("${selection.matchedFrom ?? selection.componentId}") rather than selected directly from the catalog.`,
        fixHint: 'Confirm the substitution is electrically suitable.',
        target: { artifact: 'components', componentId: selection.componentId, selectionId: selection.id },
      });
    }
    if (!selection.reason || selection.reason.trim().length < 4) {
      add('components', {
        code: 'empty_artifact',
        severity: 'warning',
        domain: 'components',
        message: `${selection.name} has no engineering reason recorded.`,
        target: { artifact: 'components', selectionId: selection.id },
      });
    }
    if (selection.quantity !== selection.instances.length) {
      add('components', {
        code: 'schema_violation',
        severity: 'error',
        domain: 'components',
        message: `${selection.name} declares quantity ${selection.quantity} but has ${selection.instances.length} instance(s).`,
        fixHint: 'Re-expand the selection instances.',
        target: { artifact: 'components', selectionId: selection.id },
      });
    }
    for (const instance of selection.instances) {
      if (instanceIds.has(instance.instanceId)) {
        add('components', {
          code: 'duplicate_instance_id',
          severity: 'error',
          domain: 'components',
          message: `Duplicate component instance id "${instance.instanceId}".`,
          target: { artifact: 'components', componentInstanceId: instance.instanceId },
        });
      }
      instanceIds.add(instance.instanceId);
    }
  }

  // Motors without a driver.
  const hasDriver = project.components.some((selection) => selection.category === 'motor_driver');
  for (const selection of project.components) {
    const definition = catalog.find((component) => component.id === selection.componentId);
    if (!definition) continue;
    if (definition.category !== 'motor') continue;
    if (definition.motorRequirements?.motorType === 'servo') continue;
    if (definition.motorRequirements?.requiresDriver !== true) continue;
    if (typeof definition.metadata.driverIntegrated === 'string') continue;
    if (hasDriver) continue;
    add('components', {
      code: 'missing_component',
      severity: 'error',
      domain: 'components',
      message: `${definition.name} needs an H-bridge/step driver but none is in the bill of materials.`,
      fixHint: 'Add L298N, L293D, TB6612FNG or A4988 depending on motor type and current.',
      target: { artifact: 'components', componentId: definition.id, selectionId: selection.id },
    });
  }
  finishCheck('components.selection', 'Component selection', 'components', mark, 'Component selection is complete and grounded in the catalog');

  /* 4. Compatibility -------------------------------------------------------- */
  mark = issues.length;
  for (const entry of project.hardwarePlan?.compatibility ?? []) {
    if (entry.compatible) continue;
    add('compatibility', {
      code: 'incompatible_components',
      severity: 'error',
      domain: 'compatibility',
      message: `${entry.a} and ${entry.b} are not compatible: ${entry.reason}`,
      fixHint: 'Insert the interface component (driver, regulator or level shifter) or choose a different part.',
      target: { artifact: 'hardwarePlan', componentId: entry.a },
    });
  }
  finishCheck('compatibility.matrix', 'Compatibility matrix', 'compatibility', mark, 'All declared component pairs are compatible');

  /* 5. Pins ----------------------------------------------------------------- */
  mark = issues.length;
  const knownInstances = instanceIds;

  /*
   * Two assignments claiming the same MCU pin is exactly the shape that produced
   * duplicate `const int` definitions in the reported safe build — the emitter
   * (uniqueCodeAssignments) keeps only the first, so the plan and the sketch
   * disagree silently. Shared buses are the one legal exception: every I2C/SPI
   * peripheral sits on the same SDA/SCL (or MOSI/MISO/SCK) pins by design.
   */
  const byMcuPin = new Map<string, PinAssignment[]>();
  for (const assignment of project.pinAssignments) {
    const key = `${assignment.mcuInstanceId}\u0000${assignment.pin}`;
    const group = byMcuPin.get(key);
    if (group) group.push(assignment);
    else byMcuPin.set(key, [assignment]);
  }
  for (const group of byMcuPin.values()) {
    if (group.length < 2) continue;
    if (group.every((assignment) => assignment.protocol === 'i2c' || assignment.protocol === 'spi')) continue;
    const keeper = group[0];
    for (const clash of group.slice(1)) {
      add('pins', {
        code: 'duplicate_pin_assignment',
        severity: 'error',
        domain: 'pins',
        message: `${clash.mcuInstanceId}.${clash.pin} is claimed twice: ${keeper.targetInstanceId}.${keeper.targetPin} and ${clash.targetInstanceId}.${clash.targetPin}. Only the first assignment reaches the sketch; the second redefines an already-declared pin constant.`,
        fixHint: `Drop this assignment or move ${clash.targetInstanceId}.${clash.targetPin} to a free pin.`,
        target: { artifact: 'pinAssignments', assignmentId: clash.id, componentInstanceId: clash.targetInstanceId, pin: clash.pin },
      });
    }
  }

  for (const assignment of project.pinAssignments) {
    if (!knownInstances.has(assignment.targetInstanceId)) {
      add('pins', {
        code: 'dangling_reference',
        severity: 'error',
        domain: 'pins',
        message: `Pin assignment ${assignment.id} targets unknown instance "${assignment.targetInstanceId}".`,
        fixHint: 'Remove the assignment or add the component.',
        target: { artifact: 'pinAssignments', assignmentId: assignment.id, componentInstanceId: assignment.targetInstanceId },
      });
      continue;
    }
    const targetDefinition = catalog.find((component) => component.id === assignment.targetComponentId);
    const targetPin = targetDefinition?.pins.find((entry) => entry.name.toLowerCase() === assignment.targetPin.toLowerCase());
    if (targetDefinition && !targetPin) {
      add('pins', {
        code: 'unknown_pin',
        severity: 'error',
        domain: 'pins',
        message: `${assignment.targetInstanceId} has no pin named "${assignment.targetPin}".`,
        details: `Valid pins: ${targetDefinition.pins.map((entry) => entry.name).join(', ')}.`,
        target: { artifact: 'pinAssignments', assignmentId: assignment.id, pin: assignment.targetPin },
      });
    }
    if (profile && assignment.mcuInstanceId === project.hardwarePlan?.controller?.instanceId) {
      const spec = profile.pins.find((entry) => entry.name === assignment.pin);
      if (!spec) {
        add('pins', {
          code: 'unknown_pin',
          severity: 'error',
          domain: 'pins',
          message: `${assignment.pin} is not a pin of ${profile.name}.`,
          target: { artifact: 'pinAssignments', assignmentId: assignment.id, pin: assignment.pin },
        });
      } else if (spec.capabilities.includes('input-only')) {
        /*
         * A pin with no digital buffer at all (Nano/Uno A6/A7, ESP32 GPIO34–39)
         * cannot serve ANY digital signal, read or driven — a digital read
         * returns garbage just as surely as a digital write does. That is a
         * different failure from a pin that is merely input-only, so it gets
         * its own code and its own advice.
         */
        const analogOnly = !spec.capabilities.includes('digital');
        if (analogOnly && (assignment.direction === 'output' || assignment.protocol !== 'adc')) {
          add('pins', {
            code: 'analog_only_pin_driven',
            severity: 'error',
            domain: 'pins',
            message: `${assignment.pin} is analog-only on ${profile.name} (no digital input/output buffer) but ${assignment.targetInstanceId}.${assignment.targetPin} is connected as ${assignment.direction}/${assignment.protocol}.`,
            fixHint: `Move ${assignment.targetInstanceId}.${assignment.targetPin} to a digital-capable pin, or use it as an analog input (analogRead) only.`,
            target: { artifact: 'pinAssignments', assignmentId: assignment.id, pin: assignment.pin },
          });
        } else if (!analogOnly && assignment.direction === 'output') {
          add('pins', {
            code: 'input_only_pin_driven',
            severity: 'error',
            domain: 'pins',
            message: `${assignment.pin} is input-only on ${profile.name} but is assigned as an output for ${assignment.targetInstanceId}.${assignment.targetPin}.`,
            fixHint: `Use an output-capable pin such as ${profile.pins.filter((entry) => !entry.capabilities.includes('input-only')).slice(0, 4).map((entry) => entry.name).join(', ')}.`,
            target: { artifact: 'pinAssignments', assignmentId: assignment.id, pin: assignment.pin },
          });
        }
      }
      const uartPort =
        spec && spec.capabilities.includes('uart')
          ? profile.uarts.find((uart) => uart.tx === assignment.pin || uart.rx === assignment.pin)
          : undefined;
      if (uartPort && assignment.protocol !== 'uart' && opensSerialPort(project, uartPort.id)) {
        /*
         * Gated on the sketch actually starting the port: D0/D1 as GPIO is only
         * a defect while the USB serial bridge is in use, and the evidence is
         * the generated code, not an assumption.
         */
        add('pins', {
          code: 'uart_pin_used_as_gpio',
          severity: 'error',
          domain: 'pins',
          message: `${assignment.pin} carries the hardware ${uartPort.id} on ${profile.name}${uartPort.note ? ` (${uartPort.note})` : ''}, the firmware starts that port, and ${assignment.targetInstanceId}.${assignment.targetPin} is wired here as ${assignment.protocol}.`,
          fixHint: `Move ${assignment.targetInstanceId}.${assignment.targetPin} to a free digital pin; ${assignment.pin} must stay on the serial port while it is in use.`,
          target: { artifact: 'pinAssignments', assignmentId: assignment.id, pin: assignment.pin },
        });
      }
      if (profile.reserved.some((entry) => entry.pin === assignment.pin)) {
        add('pins', {
          code: 'reserved_pin_used',
          severity: 'error',
          domain: 'pins',
          message: `${assignment.pin} is reserved on ${profile.name} and cannot be used for ${assignment.targetInstanceId}.${assignment.targetPin}.`,
          target: { artifact: 'pinAssignments', assignmentId: assignment.id, pin: assignment.pin },
        });
      }
    }
  }

  const peripheralNeeds = new Map<string, number>();
  for (const selection of project.components) {
    const definition = catalog.find((component) => component.id === selection.componentId);
    if (!definition) continue;
    if (definition.metadata.electrical === false || definition.metadata.integrated === true) continue;
    if (['prototyping', 'passive', 'power'].includes(definition.category)) continue;
    let needed = definition.pins.filter((entry) => entry.required && ['digital', 'analog', 'pwm', 'uart', 'i2c', 'spi', 'one_wire', 'enable'].includes(entry.type)).length;
    /*
     * A two-terminal switch (pushbutton, reed, tilt) has one leg on a GPIO and
     * the other on GND or VCC — only one MCU pin is ever assigned to it.
     */
    if (definition.category === 'input_device' && definition.metadata.momentary === true && needed >= 2) needed = 1;
    if (needed === 0) continue;
    for (const instance of selection.instances) peripheralNeeds.set(instance.instanceId, needed);
  }
  for (const [instanceId, needed] of peripheralNeeds) {
    const assigned = project.pinAssignments.filter((assignment) => assignment.targetInstanceId === instanceId).length;
    if (assigned < needed) {
      add('pins', {
        code: 'floating_required_pin',
        severity: 'warning',
        domain: 'pins',
        message: `${instanceId} needs ${needed} MCU pin(s) but only ${assigned} were assigned.`,
        fixHint: 'Assign the remaining required pins or document why they are unused.',
        target: { artifact: 'pinAssignments', componentInstanceId: instanceId },
      });
    }
  }
  finishCheck('pins.assignments', 'Pin assignment legality', 'pins', mark, 'All pin assignments are legal for the selected MCU');

  /* 6. Wiring --------------------------------------------------------------- */
  mark = issues.length;
  const wiring: WiringPlan | null = project.wiring;
  if (!wiring || wiring.connections.length === 0) {
    add('wiring', {
      code: 'empty_artifact',
      severity: 'error',
      domain: 'wiring',
      message: 'The wiring graph is empty — there is nothing to build.',
      target: { artifact: 'wiring' },
    });
  } else {
    for (const conflict of detectConflicts({
      connections: wiring.connections,
      assignments: project.pinAssignments,
      selections: project.components,
      catalog,
      ...(project.hardwarePlan?.power ? { power: project.hardwarePlan.power } : {}),
      ...(profile ? { profile } : {}),
      ...(project.hardwarePlan?.controller?.instanceId ? { controllerInstanceId: project.hardwarePlan.controller.instanceId } : {}),
    })) {
      const code = conflict.code as ValidationIssueCode;
      add('wiring', {
        // Every wiring conflict code is also a valid validation code, so the
        // conflict keeps its identity. Relabelling anything unfixable as
        // `dangling_reference` told the user a power-budget shortfall was a
        // missing reference, and pointed the fixer at the wrong artifact.
        code,
        severity: conflict.severity,
        domain: 'wiring',
        message: conflict.message,
        ...(conflict.suggestion ? { fixHint: conflict.suggestion } : {}),
        target: {
          artifact: 'wiring',
          ...(conflict.connectionIds[0] ? { connectionId: conflict.connectionIds[0] } : {}),
          ...(conflict.instanceIds[0] ? { componentInstanceId: conflict.instanceIds[0] } : {}),
          ...(conflict.pins[0] ? { pin: conflict.pins[0] } : {}),
        },
      });
    }

    // Every pin assignment must have a matching wire.
    for (const assignment of project.pinAssignments) {
      const found = wiring.connections.some(
        (connection) =>
          (connection.from.instanceId === assignment.mcuInstanceId &&
            connection.from.pin === assignment.pin &&
            connection.to.instanceId === assignment.targetInstanceId &&
            connection.to.pin.toLowerCase() === assignment.targetPin.toLowerCase()) ||
          (connection.to.instanceId === assignment.mcuInstanceId &&
            connection.to.pin === assignment.pin &&
            connection.from.instanceId === assignment.targetInstanceId &&
            connection.from.pin.toLowerCase() === assignment.targetPin.toLowerCase()) ||
          // Level-shifted or series-resistor paths are indirect but valid.
          (connection.metadata?.assignmentId === assignment.id),
      );
      const indirect = wiring.connections.some(
        (connection) =>
          connection.from.instanceId === assignment.mcuInstanceId && connection.from.pin === assignment.pin && connection.kind === 'signal',
      );
      if (!found && !indirect) {
        add('wiring', {
          code: 'dangling_reference',
          severity: 'error',
          domain: 'wiring',
          message: `Pin assignment ${assignment.mcuInstanceId}.${assignment.pin} → ${assignment.targetInstanceId}.${assignment.targetPin} has no corresponding wire.`,
          fixHint: 'Re-run the wiring stage so the connection graph matches the pin plan.',
          target: { artifact: 'wiring', assignmentId: assignment.id, pin: assignment.pin, componentInstanceId: assignment.targetInstanceId },
        });
      }
    }
  }
  finishCheck('wiring.graph', 'Wiring graph integrity', 'wiring', mark, 'Wiring graph is complete and conflict-free');

  /* 7. Power ---------------------------------------------------------------- */
  mark = issues.length;
  const power = project.hardwarePlan?.power;
  if (!power) {
    add('power', {
      code: 'empty_artifact',
      severity: 'warning',
      domain: 'power',
      message: 'No power analysis was produced.',
      target: { artifact: 'hardwarePlan' },
    });
  } else {
    if (!power.supplyComponentId) {
      add('power', {
        code: 'missing_component',
        severity: 'error',
        domain: 'power',
        message: 'No power supply is present in the hardware plan.',
        fixHint: 'Add a battery, regulator or bench supply that fits the load.',
        target: { artifact: 'components' },
      });
    }
    if (!power.adequate) {
      add('power', {
        code: 'power_budget_exceeded',
        severity: 'error',
        domain: 'power',
        message: `Power budget is not adequate: ${
          power.shortfalls?.[0] ?? power.notes[0] ?? 'the supply cannot serve the calculated load.'
        }`,
        details: power.notes.join(' '),
        fixHint: 'Increase supply capability or add regulation with headroom.',
        target: { artifact: 'hardwarePlan' },
      });
    }
  }
  /*
   * A provisional part carries a contract's worst-case numbers, not measured
   * ones. The budget it feeds is therefore an estimate, and an estimate must
   * not be reported as a pass — that is exactly the silent-confidence failure
   * the contract layer exists to prevent. Warn per part, and name the fields.
   */
  for (const selection of project.components) {
    const definition = catalog.find((component) => component.id === selection.componentId);
    if (!isProvisional(definition) || !definition) continue;
    const unverified = (definition.metadata.unverifiedFields as string[] | undefined) ?? [];
    add('power', {
      code: 'unverified_component',
      severity: 'warning',
      domain: 'power',
      message: `${selection.name} is a provisional part built from the "${definition.metadata.contractFamily}" contract, not a verified catalog entry.`,
      details: [
        unverified.length > 0 ? `Unverified: ${unverified.join(', ')}.` : '',
        ...provisionalVerification(definition),
      ]
        .filter(Boolean)
        .join(' '),
      fixHint: `Confirm the datasheet values for "${definition.metadata.requestedAs}" and add it to the component catalog.`,
      target: { artifact: 'components' },
    });
  }

  finishCheck('power.budget', 'Power budget', 'power', mark, 'Power budget is adequate for the selected supply');

  /* 8. Code ----------------------------------------------------------------- */
  mark = issues.length;
  const code = project.artifacts.code;
  if (!code || code.files.length === 0) {
    add('code', {
      code: 'empty_artifact',
      severity: 'error',
      domain: 'code',
      message: 'No firmware source was generated.',
      target: { artifact: 'code' },
    });
  } else {
    const entry = code.files.find((file) => file.path === code.entryPoint) ?? code.files[0];
    if (!entry) {
      add('code', {
        code: 'empty_artifact',
        severity: 'error',
        domain: 'code',
        message: `Entry point "${code.entryPoint}" is not present in the generated files.`,
        target: { artifact: 'code' },
      });
    } else {
      const content = entry.content;
      if (!/void\s+setup\s*\(/.test(content) || !/void\s+loop\s*\(/.test(content)) {
        add('code', {
          code: 'code_missing_setup_loop',
          severity: 'error',
          domain: 'code',
          message: `${entry.path} does not define both setup() and loop().`,
          fixHint: 'Regenerate the sketch from the software plan.',
          target: { artifact: 'code', filePath: entry.path },
        });
      }
      const balance = braceBalance(content);
      if (balance !== 0) {
        add('code', {
          code: 'code_unbalanced_braces',
          severity: 'error',
          domain: 'code',
          message: `${entry.path} has unbalanced braces (${balance > 0 ? `${balance} unclosed` : `${-balance} extra closing`}).`,
          fixHint: 'Repair the block structure or regenerate the file.',
          target: { artifact: 'code', filePath: entry.path },
        });
      }
      if (/\b(TODO|FIXME|your code here|placeholder)\b/i.test(content)) {
        add('code', {
          code: 'code_missing_setup_loop',
          severity: 'warning',
          domain: 'code',
          message: `${entry.path} still contains placeholder markers.`,
          target: { artifact: 'code', filePath: entry.path },
        });
      }

      // Pin constants must agree with the pin plan.
      for (const assignment of project.pinAssignments) {
        const name = constantName(assignment);
        const literal = pinLiteral(assignment);
        const declared = new RegExp(`(?:const\\s+\\w+\\s+${name}\\s*=\\s*([^;]+);|#define\\s+${name}\\s+(\\S+))`).exec(content);
        if (!declared) {
          add('code', {
            code: 'code_pin_mismatch',
            severity: 'warning',
            domain: 'code',
            message: `${entry.path} does not declare ${name} for ${assignment.mcuInstanceId}.${assignment.pin} → ${assignment.targetInstanceId}.${assignment.targetPin}.`,
            fixHint: 'Re-inject the generated pin map block.',
            target: { artifact: 'code', filePath: entry.path, pin: assignment.pin },
          });
          continue;
        }
        const value = (declared[1] ?? declared[2] ?? '').trim();
        if (value !== literal) {
          add('code', {
            code: 'code_pin_mismatch',
            severity: 'error',
            domain: 'code',
            message: `${entry.path} declares ${name} = ${value} but the pin plan assigns ${assignment.pin} (${literal}).`,
            fixHint: `Set ${name} to ${literal}.`,
            target: { artifact: 'code', filePath: entry.path, pin: assignment.pin },
          });
        }
      }

      // Hand-written pin constants must not contradict the pin plan either.
      // (`const int BUTTON_PIN = 2;` next to a pin map that says D4 is the
      // exact bug that shipped a sketch which never saw the button.)
      const strayConstants = syncPinConstants(content, project.pinAssignments);
      for (const stray of strayConstants.synced) {
        add('code', {
          code: 'code_pin_mismatch',
          severity: 'error',
          domain: 'code',
          message: `${entry.path} declares ${stray.name} = ${stray.from} but the pin plan wires that peripheral to ${stray.to}.`,
          fixHint: `Set ${stray.name} to ${stray.to} or reference the generated PIN_* constant.`,
          target: { artifact: 'code', filePath: entry.path },
        });
      }

      // I2C hygiene: hex addresses that match the catalog, and a started bus.
      const hygieneContext = { selections: project.components, catalog, libraries: project.artifacts.libraries?.libraries ?? project.softwarePlan?.libraries ?? [] };
      const addresses = fixI2cAddressLiterals(content, hygieneContext);
      for (const fix of addresses.fixed) {
        add('code', {
          code: 'code_i2c_address_invalid',
          severity: 'error',
          domain: 'code',
          message: `${entry.path} sets ${fix.name} to ${fix.from}; the catalog address for that I2C device is ${fix.to}.`,
          fixHint: `Write the address as a hex literal: ${fix.to}.`,
          target: { artifact: 'code', filePath: entry.path },
        });
      }
      if (ensureWireBegin(content, hygieneContext).added) {
        add('code', {
          code: 'code_missing_bus_init',
          severity: 'error',
          domain: 'code',
          message: `${entry.path} drives an I2C peripheral but never calls Wire.begin().`,
          fixHint: 'Call Wire.begin() in setup() before initialising any I2C device.',
          target: { artifact: 'code', filePath: entry.path },
        });
      }
      const stray = pruneIncludes(content, hygieneContext);
      for (const header of stray.removed) {
        add('code', {
          code: 'code_stray_include',
          severity: 'warning',
          domain: 'code',
          message: `${entry.path} includes <${header}> but no library in the plan provides it (or it duplicates the managed include block).`,
          fixHint: `Remove #include <${header}> or add the library to the plan.`,
          target: { artifact: 'code', filePath: entry.path, library: header },
        });
      }

      // Includes must cover every library.
      const allCode = code.files.map((file) => file.content).join('\n');
      for (const library of project.artifacts.libraries?.libraries ?? []) {
        if (library.builtIn && /^Arduino\.h$/i.test(library.import)) continue;
        const statement = includeStatement(library);
        if (!statement) continue;
        if (!allCode.includes(library.import)) {
          add('code', {
            code: 'code_missing_include',
            severity: 'warning',
            domain: 'code',
            message: `Library "${library.name}" is required but ${library.import} is never included.`,
            fixHint: `Add ${statement} to ${entry.path}.`,
            target: { artifact: 'code', filePath: entry.path, library: library.name },
          });
        }
      }
    }
  }
  finishCheck('code.firmware', 'Firmware correctness', 'code', mark, 'Firmware is structurally sound and matches the pin plan');

  /* 9. Libraries ------------------------------------------------------------ */
  mark = issues.length;
  if (project.artifacts.libraries) {
    const parsed = LibrariesArtifactSchema.safeParse(project.artifacts.libraries);
    if (!parsed.success) {
      add('libraries', {
        code: 'schema_violation',
        severity: 'error',
        domain: 'libraries',
        message: 'libraries.json violates its schema.',
        details: parsed.error.issues.slice(0, 4).map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '),
        target: { artifact: 'libraries' },
      });
    }
    const codeText = (project.artifacts.code?.files ?? []).map((file) => file.content).join('\n');
    const includePattern = /#\s*include\s*[<"]([^>"]+)[>"]/g;
    const included = new Set<string>();
    let includeMatch: RegExpExecArray | null;
    while ((includeMatch = includePattern.exec(codeText)) !== null) included.add(String(includeMatch[1] ?? '').toLowerCase());

    const listed = new Set((project.artifacts.libraries.libraries ?? []).map((library) => library.import.toLowerCase()));
    for (const header of included) {
      if (!header) continue;
      if (/^(Arduino|Wire|SPI|SoftwareSerial|Servo|BluetoothSerial|WiFi|BLEDevice|EEPROM)\.h$/i.test(header)) continue;
      if (!listed.has(header)) {
        add('libraries', {
          code: 'library_missing',
          severity: 'error',
          domain: 'libraries',
          message: `The firmware includes <${header}> but libraries.json does not list it.`,
          fixHint: `Add an entry for ${header} with its install instructions.`,
          target: { artifact: 'libraries', library: header },
        });
      }
    }
  } else {
    add('libraries', {
      code: 'empty_artifact',
      severity: 'warning',
      domain: 'libraries',
      message: 'libraries.json was not generated.',
      target: { artifact: 'libraries' },
    });
  }
  finishCheck('libraries.manifest', 'Library manifest', 'libraries', mark, 'libraries.json matches the firmware includes');

  /* 10. Diagram ------------------------------------------------------------- */
  mark = issues.length;
  const diagram: Diagram | null = project.artifacts.diagram;
  const integrity = checkDiagramIntegrity(diagram);
  for (const problem of integrity.problems) {
    add('diagram', {
      code: 'diagram_out_of_sync',
      severity: 'error',
      domain: 'diagram',
      message: problem,
      fixHint: 'Regenerate diagram.json from the current wiring graph.',
      target: { artifact: 'diagram' },
    });
  }
  if (diagram) {
    const parsed = DiagramSchema.safeParse(diagram);
    if (!parsed.success) {
      add('diagram', {
        code: 'schema_violation',
        severity: 'error',
        domain: 'diagram',
        message: 'diagram.json violates the Wireup diagram schema.',
        details: parsed.error.issues.slice(0, 4).map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '),
        target: { artifact: 'diagram' },
      });
    }
    if (diagram.revision !== project.revision) {
      add('diagram', {
        code: 'diagram_out_of_sync',
        severity: 'error',
        domain: 'diagram',
        message: `diagram.json was generated at revision ${diagram.revision} but the project is at revision ${project.revision}.`,
        fixHint: 'Re-run the diagram stage.',
        target: { artifact: 'diagram' },
      });
    }
    for (const missing of findMissingDiagramComponents(diagram, project.components, catalog)) {
      add('diagram', {
        code: 'diagram_missing_component',
        severity: 'error',
        domain: 'diagram',
        message: `Component instance "${missing}" is in the bill of materials but missing from diagram.json.`,
        fixHint: 'Regenerate the diagram.',
        target: { artifact: 'diagram', componentInstanceId: missing },
      });
    }
    for (const connection of project.wiring?.connections ?? []) {
      const present = diagram.connections.some((entry) => entry.id === connection.id);
      if (!present) {
        add('diagram', {
          code: 'diagram_missing_connection',
          severity: 'error',
          domain: 'diagram',
          message: `Wiring connection ${connection.from.instanceId}.${connection.from.pin} → ${connection.to.instanceId}.${connection.to.pin} is missing from diagram.json.`,
          fixHint: 'Regenerate the diagram from the wiring graph.',
          target: { artifact: 'diagram', connectionId: connection.id },
        });
      }
    }
  }
  finishCheck('diagram.integrity', 'diagram.json integrity', 'diagram', mark, 'diagram.json is complete and internally consistent');

  /* 11. Instructions -------------------------------------------------------- */
  mark = issues.length;
  const instructions = project.artifacts.instructions;
  if (!instructions) {
    add('instructions', {
      code: 'empty_artifact',
      severity: 'warning',
      domain: 'instructions',
      message: 'No setup instructions were generated.',
      target: { artifact: 'instructions' },
    });
  } else {
    const parsed = InstructionsArtifactSchema.safeParse(instructions);
    if (!parsed.success) {
      add('instructions', {
        code: 'schema_violation',
        severity: 'error',
        domain: 'instructions',
        message: 'The instructions artifact violates its schema.',
        details: parsed.error.issues.slice(0, 4).map((entry) => `${entry.path.join('.')}: ${entry.message}`).join('; '),
        target: { artifact: 'instructions' },
      });
    }
    const requiredSections = ['overview', 'bill-of-materials', 'wiring', 'pinout', 'power', 'software-setup', 'flashing', 'usage'];
    const presentIds = new Set(instructions.sections.map((section) => section.id));
    for (const sectionId of requiredSections) {
      if (!presentIds.has(sectionId)) {
        add('instructions', {
          code: 'instructions_missing_section',
          severity: 'warning',
          domain: 'instructions',
          message: `Instructions are missing the "${sectionId}" section.`,
          fixHint: 'Re-run the instructions generator.',
          target: { artifact: 'instructions', sectionId },
        });
      }
    }
    if (instructions.billOfMaterials.length !== project.components.length) {
      add('instructions', {
        code: 'instructions_out_of_sync',
        severity: 'warning',
        domain: 'instructions',
        message: `Bill of materials lists ${instructions.billOfMaterials.length} line(s) but the project has ${project.components.length} selection(s).`,
        fixHint: 'Regenerate the instructions after the component change.',
        target: { artifact: 'instructions', sectionId: 'bill-of-materials' },
      });
    }
  }
  finishCheck('instructions.completeness', 'Instruction completeness', 'instructions', mark, 'Instructions cover every required section');

  /* 12. 3D assembly --------------------------------------------------------- */
  mark = issues.length;
  const assembly = project.assembly;
  if (assembly && diagram) {
    const diagramIds = new Set(diagram.components.map((component) => component.id));
    const refById = new Map(diagram.components.map((component) => [component.id, component.ref]));
    for (const [role, id] of Object.entries(assembly.bindings)) {
      if (id && !diagramIds.has(id)) {
        add('assembly', {
          code: 'assembly_unknown_part',
          severity: 'error',
          domain: 'assembly',
          message: `3D seat "${role}" points at "${id}", which is no longer in diagram.json.`,
          fixHint: 'Prune the stale 3D seats.',
          target: { artifact: 'assembly', componentInstanceId: id },
        });
      }
    }
    for (const [id, seat] of Object.entries(assembly.placements)) {
      if (!diagramIds.has(id)) {
        add('assembly', {
          code: 'assembly_unknown_part',
          severity: 'error',
          domain: 'assembly',
          message: `3D placement for "${id}", which is no longer in diagram.json.`,
          fixHint: 'Prune the stale 3D seats.',
          target: { artifact: 'assembly', componentInstanceId: id },
        });
        continue;
      }
      const finiteSeat =
        seat && Number.isFinite(seat.x) && Number.isFinite(seat.y) && Number.isFinite(seat.z);
      const inBounds =
        finiteSeat &&
        Math.abs(seat.x) <= 1500 &&
        seat.y >= 0 &&
        seat.y <= 800 &&
        Math.abs(seat.z) <= 1500 &&
        (seat.rotY === undefined || Number.isFinite(seat.rotY));
      if (!inBounds) {
        add('assembly', {
          code: 'assembly_bad_placement',
          severity: 'error',
          domain: 'assembly',
          message: `3D placement for "${id}" is ${finiteSeat ? 'out of bounds' : 'not finite'} — it would render off the bench.`,
          fixHint: 'Drop the bad seat so the part falls back to the bench grid.',
          target: { artifact: 'assembly', componentInstanceId: id },
        });
      }
    }
    for (const id of assembly.parametric) {
      if (!diagramIds.has(id)) {
        add('assembly', {
          code: 'assembly_unknown_part',
          severity: 'error',
          domain: 'assembly',
          message: `Parametric 3D carrier "${id}" is no longer in diagram.json.`,
          fixHint: 'Prune the stale 3D seats.',
          target: { artifact: 'assembly', componentInstanceId: id },
        });
      }
    }
    // Overlaps are reported, not repaired: only a human (or a re-plan) can
    // judge the intended layout.
    const placedIds = Object.keys(assembly.placements).filter((id) => diagramIds.has(id));
    let overlapReports = 0;
    for (let i = 0; i < placedIds.length && overlapReports < 3; i++) {
      for (let j = i + 1; j < placedIds.length && overlapReports < 3; j++) {
        const refA = refById.get(placedIds[i]!) ?? '';
        const refB = refById.get(placedIds[j]!) ?? '';
        if (isAxleJoint(refA, refB)) continue;
        const a = assembly.placements[placedIds[i]!]!;
        const b = assembly.placements[placedIds[j]!]!;
        const da = dimsFor(refA);
        const db = dimsFor(refB);
        const overlap =
          Math.abs(a.x - b.x) < (da.w + db.w) / 2 &&
          Math.abs(a.z - b.z) < (da.l + db.l) / 2 &&
          Math.abs(a.y - b.y) < ((da.h + db.h) / 2) * 0.8;
        if (overlap) {
          overlapReports += 1;
          add('assembly', {
            code: 'assembly_overlap',
            severity: 'warning',
            domain: 'assembly',
            message: `Possible 3D overlap: "${placedIds[i]}" intersects "${placedIds[j]}".`,
            fixHint: 'Re-plan the 3D shape, or drag the parts apart in the 3D view.',
            target: { artifact: 'assembly', componentInstanceId: placedIds[i] },
          });
        }
      }
    }
  }
  finishCheck(
    'assembly.seats',
    '3D assembly seats',
    'assembly',
    mark,
    assembly ? 'Every 3D seat points at a real part' : 'No 3D assembly planned yet',
  );

  return { checks, issues };
}

/** Group issues by the artifact they target — used to route targeted fixes. */
export function groupIssuesByArtifact(issues: ValidationIssue[]): Map<string, ValidationIssue[]> {
  const groups = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    const key = issue.target?.artifact ?? issue.domain;
    const list = groups.get(key) ?? [];
    list.push(issue);
    groups.set(key, list);
  }
  return groups;
}

export function summariseIssues(issues: ValidationIssue[]): { errors: number; warnings: number; info: number } {
  return {
    errors: issues.filter((issue) => issue.severity === 'error').length,
    warnings: issues.filter((issue) => issue.severity === 'warning').length,
    info: issues.filter((issue) => issue.severity === 'info').length,
  };
}

export type { ComponentSelection, PinAssignment };
