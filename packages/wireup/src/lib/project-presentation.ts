/**
 * Pure presentation helpers.
 *
 * Turn the internal `ProjectState` into the human-facing narrative the output
 * pages use: plain-language status phrases, a six-step build progress, and an
 * "overview" summary (what was built + what to do next). No JSX, no React, so it
 * is safe to import from both server and client code.
 */

import type { GenerationStage, ProjectState, ProjectStatus } from '@/types/project';

/* -------------------------------------------------------------------------- */
/* Stage → plain language                                                      */
/* -------------------------------------------------------------------------- */

const STAGE_LABEL: Record<GenerationStage, string> = {
  idle: 'Preparing',
  understanding: 'Reading your request',
  catalog: 'Finding the right parts',
  generating: 'Mapping your request to parts',
  hardware: 'Planning the hardware',
  pins: 'Assigning the pins',
  wiring: 'Wiring it together',
  software: 'Planning the software',
  code: 'Writing the firmware',
  libraries: 'Adding the libraries',
  diagram: 'Drawing the diagram',
  assembly: 'Assembling it in 3D',
  instructions: 'Writing your build guide',
  validating: 'Checking the build',
  fixing: 'Repairing a few issues',
  completed: 'Done',
  failed: 'Didn\u2019t get there',
};

export function humanStageLabel(stage: GenerationStage | undefined | null): string {
  return STAGE_LABEL[stage ?? 'idle'] ?? 'Working';
}

/* -------------------------------------------------------------------------- */
/* Status → plain language                                                     */
/* -------------------------------------------------------------------------- */

const STATUS_PHRASE: Record<ProjectStatus, string> = {
  intake: 'The doubt session is ready \u2014 answer what only you know',
  pending: 'Waiting to start\u2026',
  running: 'Building your project',
  validating: 'Checking your build',
  fixing: 'Repairing a few issues',
  completed: 'Ready \u2014 here\u2019s your project',
  completed_with_warnings: 'Ready \u2014 a few things to look at',
  completed_with_errors: 'Finished \u2014 some issues need attention',
  failed: 'Didn\u2019t get there',
};

export function statusPhrase(status: ProjectStatus | undefined | null): string {
  return STATUS_PHRASE[status ?? 'pending'];
}

/** Phase 0: the doubt session gates the build. */
export function isIntake(status: ProjectStatus | undefined | null): boolean {
  return status === 'intake';
}

/** Whether a status means "still going" (not terminal). */
export function isInProgress(status: ProjectStatus | undefined | null): boolean {
  return status !== undefined && status !== null && !(status === 'completed' || status === 'completed_with_warnings' || status === 'completed_with_errors' || status === 'failed' || status === 'intake');
}

/* -------------------------------------------------------------------------- */
/* Build progress                                                              */
/* -------------------------------------------------------------------------- */

export interface BuildStep {
  key: 'understand' | 'parts' | 'wire' | 'software' | 'package' | 'check';
  label: string;
  state: 'done' | 'active' | 'todo';
}

const STEP_LABEL: Record<BuildStep['key'], string> = {
  understand: 'Understand your request',
  parts: 'Pick the parts',
  wire: 'Wire it up',
  software: 'Write the firmware',
  package: 'Build guide & diagram',
  check: 'Check the build',
};

function stepDone(project: ProjectState | null, key: BuildStep['key']): boolean {
  if (!project) return false;
  switch (key) {
    case 'understand':
      return Boolean(project.requirements);
    case 'parts':
      return project.components.length > 0;
    case 'wire':
      return Boolean(project.wiring) || project.pinAssignments.length > 0;
    case 'software':
      return Boolean(project.artifacts?.code);
    case 'package':
      return Boolean(project.artifacts?.instructions) && Boolean(project.artifacts?.diagram);
    case 'check':
      return Boolean(project.validation);
  }
}

export function buildSteps(project: ProjectState | null): BuildStep[] {
  const order: BuildStep['key'][] = ['understand', 'parts', 'wire', 'software', 'package', 'check'];
  let firstTodoAssigned = false;
  return order.map((key) => {
    const done = stepDone(project, key);
    let state: BuildStep['state'] = done ? 'done' : 'todo';
    if (!done && !firstTodoAssigned && project) {
      state = 'active';
      firstTodoAssigned = true;
    }
    return { key, label: STEP_LABEL[key], state };
  });
}

/* -------------------------------------------------------------------------- */
/* Overview summary                                                            */
/* -------------------------------------------------------------------------- */

export interface OverviewFact {
  label: string;
  value: string;
}

export interface ProjectOverview {
  headline: string;
  subhead: string;
  facts: OverviewFact[];
  nextSteps: string[];
}

export function projectOverview(project: ProjectState | null): ProjectOverview {
  if (!project) {
    return { headline: 'Loading your project\u2026', subhead: '', facts: [], nextSteps: [] };
  }

  const controller = project.hardwarePlan?.controller?.name;
  const partTypes = project.components.length;
  const instances = project.components.reduce((sum, selection) => sum + selection.instances.length, 0);
  const wires = project.wiring?.connections.length ?? 0;
  const files = project.artifacts?.code?.files.length ?? 0;
  const sections = project.artifacts?.instructions?.sections.length ?? 0;
  const passed = project.validation?.passed;

  const facts: OverviewFact[] = [];
  if (controller) facts.push({ label: 'Controller', value: controller });
  if (partTypes > 0) facts.push({ label: 'Parts', value: instances > 0 ? plural(instances, 'part') : plural(partTypes, 'part type') });
  if (wires > 0) facts.push({ label: 'Wires', value: plural(wires, 'wire') });
  if (files > 0) facts.push({ label: 'Firmware', value: plural(files, 'file') });
  if (sections > 0) facts.push({ label: 'Build guide', value: plural(sections, 'step') });
  if (project.validation) facts.push({ label: 'Check', value: passed ? 'Passed' : 'Needs attention' });

  const goal = project.requirements?.goal?.trim();
  const headline = controller ? `${controller} project` : project.name || 'Project';
  const subhead = goal || (instances > 0 ? 'Built from your brief.' : project.prompt?.trim().slice(0, 120) || '');

  const nextSteps: string[] = [];
  if (project.artifacts?.instructions) nextSteps.push('Read the build guide to assemble it.');
  if (project.artifacts?.diagram) nextSteps.push('Open the diagram in a simulator.');
  if (project.artifacts?.code) nextSteps.push('Grab the firmware for your editor.');
  if (wires > 0) nextSteps.push('Follow the wiring to connect everything.');

  return { headline, subhead, facts, nextSteps };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}
