/**
 * Assembly proposal schema — the JSON contract the model answers with.
 *
 * The model never invents hardware here either: bindings and placements may
 * only reference diagram instance ids from the roster it is shown, and the
 * resolver drops anything else with a recorded note.
 */

import { z } from 'zod';

export const ASSEMBLY_ROLES = [
  'motor_left',
  'motor_right',
  'motor_fl',
  'motor_fr',
  'motor_rl',
  'motor_rr',
  'motor_1',
  'motor_2',
  'motor_3',
  'motor_4',
  'motor_5',
  'motor_6',
  'wheel_left',
  'wheel_right',
  'wheel_fl',
  'wheel_fr',
  'wheel_rl',
  'wheel_rr',
  'caster_front',
  'caster_back',
  'imu',
  'battery',
  'controller',
  'sensor_front',
  'sensor_back',
  'sensor_left',
  'sensor_right',
  'passenger',
  'passenger_0',
  'passenger_1',
  'passenger_2',
  'passenger_3',
  'passenger_4',
  'passenger_5',
  'passenger_6',
  'passenger_7',
] as const;

const Vec3Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

const MountSchema = z.object({
  role: z.enum(ASSEMBLY_ROLES),
  at: Vec3Schema,
  rotY: z.number().finite().optional(),
});

const ChassisSchema = z.object({
  shape: z.enum(['horizontal_plate', 'vertical_plate', 'box', 'frame', 'custom_mesh']),
  size: Vec3Schema,
  thickness: z.number().finite().positive().max(100).optional(),
  color: z.string().max(32).optional(),
  label: z.string().max(80).optional(),
  mounts: z.array(MountSchema).max(64),
  meshUrl: z.string().max(500).optional(),
});

const PlacementSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  rotY: z.number().finite().optional(),
});

/**
 * Parametric extras sizing. Wheels, casters and propellers are not electrical
 * parts, so they never appear in the roster — the scene renders them straight
 * from this spec. The model may size them to the product.
 */
const WheelOverrideSchema = z.object({
  /** Wheel diameter in mm — on flying frames this is the propeller disc. */
  diameterMm: z.number().finite().min(20).max(300).optional(),
  widthMm: z.number().finite().min(5).max(120).optional(),
  tireColor: z.string().max(32).optional(),
  color: z.string().max(32).optional(),
});

/**
 * What the model may return. Every field is optional: `{}` is a valid
 * proposal meaning "the deterministic baseline is fine". Fields present
 * override the resolved base archetype (see `resolve.ts` for merge rules).
 */
export const AssemblyProposalSchema = z.object({
  /** Base archetype to start from (`2wd_rover`, `4wd_rover`, `self_balancer`, `quadcopter`, `mecanum`, `static_bench`). */
  archetype: z.string().max(64).optional(),
  /** Human label for the assembled product, e.g. `RC car`. */
  label: z.string().max(80).optional(),
  /** Full custom chassis — replaces the base archetype's chassis when present. */
  chassis: ChassisSchema.optional(),
  /** Mounts that replace (same role) or extend (`passenger`) the base mounts. */
  mounts: z.array(MountSchema).max(64).optional(),
  /** Parametric extras sizing: the wheels (or drone prop discs) the scene renders at the wheel/motor mounts. */
  wheel: WheelOverrideSchema.optional(),
  /** Role → diagram instance id. Only roster ids survive resolution. */
  bindings: z.record(z.string(), z.string()).optional(),
  /** Explicit world placements in bench mm (for static builds / extras). */
  placements: z.record(z.string(), PlacementSchema).optional(),
  /** Where the assembled product sits on the bench (world mm). */
  origin: Vec3Schema.optional(),
  /** Initial heading in degrees. */
  rotYDeg: z.number().finite().optional(),
  /** One or two sentences on why this shape fits the build. */
  notes: z.string().max(600).optional(),
});

export type AssemblyProposal = z.infer<typeof AssemblyProposalSchema>;

/** Parse leniently: unknown keys are stripped, malformed proposals rejected. */
export function parseAssemblyProposal(raw: unknown): AssemblyProposal | null {
  const parsed = AssemblyProposalSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
