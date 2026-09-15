/**
 * Runtime validation schemas for persisted/API-facing project data.
 *
 * The domain types live in `src/types`; these schemas are used to (a) validate
 * what we hand to the frontend and (b) power the validator's structural checks
 * so schema violations become first-class validation issues.
 */

import { z } from 'zod';

export const ConnectionKindSchema = z.enum(['power', 'ground', 'signal']);

export const SignalTypeSchema = z.enum([
  'digital',
  'analog',
  'pwm',
  'uart',
  'i2c',
  'spi',
  'one_wire',
  'motor_drive',
  'enable',
  'interrupt',
  'power',
  'ground',
  'unknown',
]);

export const WiringEndpointSchema = z.object({
  componentId: z.string().min(1),
  instanceId: z.string().min(1),
  pin: z.string().min(1),
  pinLabel: z.string().optional(),
});

export const WiringConnectionSchema = z.object({
  id: z.string().min(1),
  from: WiringEndpointSchema,
  to: WiringEndpointSchema,
  kind: ConnectionKindSchema,
  signal: SignalTypeSchema,
  protocol: z.string(),
  direction: z.enum(['unidirectional', 'bidirectional']),
  voltage: z.number().optional(),
  explanation: z.string(),
  source: z.enum(['planner', 'model', 'fixer']),
  wireColor: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const PinAssignmentSchema = z.object({
  id: z.string().min(1),
  mcuInstanceId: z.string().min(1),
  mcuComponentId: z.string().min(1),
  pin: z.string().min(1),
  pinNumber: z.number().int().optional(),
  targetInstanceId: z.string().min(1),
  targetComponentId: z.string().min(1),
  targetPin: z.string().min(1),
  purpose: z.string(),
  signal: SignalTypeSchema,
  direction: z.enum(['input', 'output']),
  protocol: z.string(),
  required: z.boolean(),
  rationale: z.string(),
  source: z.enum(['planner', 'model', 'fixer']),
});

export const ComponentInstanceSchema = z.object({
  instanceId: z.string().min(1),
  componentId: z.string().min(1),
  name: z.string().min(1),
  index: z.number().int().positive(),
  label: z.string().optional(),
  category: z.string(),
});

export const ComponentSelectionSchema = z.object({
  id: z.string().min(1),
  componentId: z.string().min(1),
  name: z.string().min(1),
  category: z.string(),
  role: z.string(),
  quantity: z.number().int().positive(),
  reason: z.string().min(1),
  required: z.boolean(),
  instances: z.array(ComponentInstanceSchema),
  source: z.enum(['catalog', 'model', 'planner']),
  matchedFrom: z.string().optional(),
  notes: z.string().optional(),
});

export const CodeFileSchema = z.object({
  path: z.string().min(1),
  language: z.string(),
  content: z.string(),
  purpose: z.string(),
  generatedBy: z.enum(['model', 'planner', 'fixer']),
});

export const CodeArtifactSchema = z.object({
  files: z.array(CodeFileSchema).min(1),
  entryPoint: z.string(),
  pinsSynchronised: z.boolean(),
  notes: z.array(z.string()),
});

export const DiagramPinSchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  type: z.string().optional(),
  direction: z.enum(['input', 'output', 'bidirectional', 'power', 'ground']).optional(),
  assignedTo: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  connected: z.boolean().optional(),
});

export const DiagramComponentSchema = z.object({
  id: z.string().min(1),
  ref: z.string().min(1),
  type: z.string(),
  name: z.string(),
  label: z.string().optional(),
  category: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
  pins: z.array(DiagramPinSchema),
  simulator: z
    .object({
      part: z.string().optional(),
      attrs: z.record(z.string(), z.string()).optional(),
      supported: z.boolean().optional(),
      notes: z.string().optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const DiagramConnectionSchema = z.object({
  id: z.string().min(1),
  from: z.object({ component: z.string().min(1), pin: z.string().min(1) }),
  to: z.object({ component: z.string().min(1), pin: z.string().min(1) }),
  kind: ConnectionKindSchema,
  signal: SignalTypeSchema,
  label: z.string().optional(),
  wireColor: z.string().optional(),
  voltage: z.number().optional(),
  path: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
});

export const DiagramSchema = z.object({
  version: z.literal('1.0'),
  format: z.literal('wireup-diagram'),
  generator: z.string(),
  createdAt: z.string(),
  projectId: z.string(),
  revision: z.number().int(),
  meta: z.object({
    title: z.string(),
    description: z.string(),
    platform: z.string().optional(),
    controllerInstanceId: z.string().optional(),
    simulatorTarget: z.enum(['generic', 'wokwi']),
    units: z.literal('px'),
    gridSize: z.number(),
  }),
  components: z.array(DiagramComponentSchema),
  connections: z.array(DiagramConnectionSchema),
  rails: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(['power', 'ground']),
      voltage: z.number().optional(),
      members: z.array(z.object({ component: z.string(), pin: z.string() })),
    }),
  ),
  groups: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      memberIds: z.array(z.string()),
    }),
  ),
  layout: z.object({
    width: z.number(),
    height: z.number(),
    columns: z.number(),
    rows: z.number(),
  }),
  stats: z.object({
    components: z.number(),
    connections: z.number(),
    powerConnections: z.number(),
    groundConnections: z.number(),
    signalConnections: z.number(),
    pins: z.number(),
  }),
});

export const LibrariesArtifactSchema = z.object({
  libraries: z.array(
    z.object({
      name: z.string().min(1),
      import: z.string().min(1),
      manager: z.string().optional(),
      version: z.string().optional(),
      repository: z.string().optional(),
      purpose: z.string(),
      builtIn: z.boolean().optional(),
    }),
  ),
  installCommands: z.array(z.string()),
  notes: z.array(z.string()),
  generatedAt: z.string(),
});

export const InstructionsArtifactSchema = z.object({
  markdown: z.string().min(1),
  sections: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      order: z.number(),
    }),
  ),
  billOfMaterials: z.array(
    z.object({ name: z.string(), quantity: z.number(), notes: z.string().optional() }),
  ),
  estimatedBuildTimeMinutes: z.number().optional(),
  generatedAt: z.string(),
});

export const ProjectRequirementsSchema = z.object({
  goal: z.string().min(1),
  summary: z.string(),
  requirements: z.array(z.string()),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  behaviors: z.array(z.string()),
  constraints: z.array(z.string()),
  platformRequirements: z.array(z.string()),
  communicationRequirements: z.array(z.string()),
  powerRequirements: z.array(z.string()),
  quantities: z.record(z.string(), z.number()),
  features: z.array(z.string()),
  assumptions: z.array(z.string()),
  ambiguities: z.array(z.string()),
  detectedPlatform: z.string().optional(),
  behavioralSpec: z.unknown().optional(),
});

export const ValidationResultSchema = z.object({
  passed: z.boolean(),
  iteration: z.number().int(),
  checkedAt: z.string(),
  durationMs: z.number(),
  issues: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      severity: z.enum(['error', 'warning', 'info']),
      domain: z.string(),
      message: z.string(),
      details: z.string().optional(),
      autoFixable: z.boolean(),
      origin: z.enum(['rules', 'model']),
      target: z
        .object({
          artifact: z.string(),
          componentInstanceId: z.string().optional(),
          componentId: z.string().optional(),
          selectionId: z.string().optional(),
          pin: z.string().optional(),
          assignmentId: z.string().optional(),
          connectionId: z.string().optional(),
          filePath: z.string().optional(),
          library: z.string().optional(),
          sectionId: z.string().optional(),
        })
        .optional(),
      fixHint: z.string().optional(),
    }),
  ),
  checks: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      domain: z.string(),
      status: z.enum(['passed', 'failed', 'skipped']),
      message: z.string(),
      issueIds: z.array(z.string()),
    }),
  ),
  summary: z.object({
    errors: z.number(),
    warnings: z.number(),
    info: z.number(),
    checksRun: z.number(),
    checksPassed: z.number(),
  }),
  engineError: z.string().optional(),
});

export const AgentEventSchema = z.object({
  seq: z.number().int(),
  id: z.string(),
  type: z.string(),
  status: z.enum(['started', 'completed', 'failed', 'info']),
  message: z.string(),
  timestamp: z.string(),
  stage: z.string().optional(),
  durationMs: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
