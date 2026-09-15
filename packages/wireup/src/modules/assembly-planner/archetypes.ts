/**
 * Server-side archetype tables — the deterministic shape library.
 *
 * These mirror Velxio's `scene3d/assembly/archetypes.ts` mount for mount, so
 * the `.vlx` bake (world placements computed here) and LiveGround (chassis +
 * kinematics applied there) assemble the SAME vehicle. `pnpm verify:assembly`
 * imports both tables and fails on any drift.
 *
 * Wheel-mount heights are authored so parametric wheels rest ON the bench:
 * wheel centre y = max(mount y, radius − origin y). The Velxio tables carry
 * the same numbers.
 */

import type { AssemblySpecJson } from '@/types/assembly';

export const ASSEMBLY_ARCHETYPE_IDS = [
  '2wd_rover',
  '4wd_rover',
  'self_balancer',
  'quadcopter',
  'mecanum',
  'static_bench',
] as const;

export type AssemblyArchetypeId = (typeof ASSEMBLY_ARCHETYPE_IDS)[number];

const TWO_WD_ROVER: AssemblySpecJson = {
  archetype: '2wd_rover',
  chassis: {
    shape: 'horizontal_plate',
    size: { x: 250, y: 2, z: 150 },
    thickness: 2,
    color: '#2b6cff',
    label: '2WD acrylic rover deck',
    mounts: [
      { role: 'motor_left', at: { x: -70, y: 28, z: 65 }, rotY: 90 },
      { role: 'motor_right', at: { x: -70, y: 28, z: -65 }, rotY: 90 },
      { role: 'wheel_left', at: { x: -70, y: 28, z: 88 } },
      { role: 'wheel_right', at: { x: -70, y: 28, z: -88 } },
      { role: 'caster_front', at: { x: 128, y: 13, z: 0 } },
      { role: 'controller', at: { x: -30, y: 4, z: 0 }, rotY: 0 },
      { role: 'battery', at: { x: 60, y: 4, z: 0 } },
      { role: 'sensor_front', at: { x: 120, y: 36, z: 0 } },
    ],
  },
  wheel: { diameterMm: 65, widthMm: 26, tireColor: '#1a1a1a', color: '#b5b5b5' },
  kinematics: {
    model: 'differential_drive',
    wheelbaseMm: 130,
    deadbandRps: 0.05,
    closedLoopSensors: false,
  },
  origin: { x: -100, y: 5, z: 300 },
  rotYDeg: 0,
};

const FOUR_WD_ROVER: AssemblySpecJson = {
  archetype: '4wd_rover',
  chassis: {
    shape: 'horizontal_plate',
    size: { x: 260, y: 2, z: 180 },
    thickness: 3,
    color: '#2e7d32',
    label: '4WD off-road chassis',
    mounts: [
      { role: 'motor_fl', at: { x: 90, y: 35, z: 80 }, rotY: 90 },
      { role: 'motor_fr', at: { x: 90, y: 35, z: -80 }, rotY: 90 },
      { role: 'motor_rl', at: { x: -90, y: 35, z: 80 }, rotY: 90 },
      { role: 'motor_rr', at: { x: -90, y: 35, z: -80 }, rotY: 90 },
      { role: 'wheel_fl', at: { x: 90, y: 35, z: 105 } },
      { role: 'wheel_fr', at: { x: 90, y: 35, z: -105 } },
      { role: 'wheel_rl', at: { x: -90, y: 35, z: 105 } },
      { role: 'wheel_rr', at: { x: -90, y: 35, z: -105 } },
      { role: 'controller', at: { x: 0, y: 4, z: 0 } },
      { role: 'battery', at: { x: -60, y: 4, z: 0 } },
      { role: 'sensor_front', at: { x: 132, y: 22, z: 0 } },
    ],
  },
  wheel: { diameterMm: 80, widthMm: 30, tireColor: '#1a1a1a' },
  kinematics: {
    model: 'differential_drive',
    wheelbaseMm: 160,
    trackMm: 180,
    deadbandRps: 0.05,
  },
  origin: { x: -100, y: 5, z: 300 },
};

const SELF_BALANCER: AssemblySpecJson = {
  archetype: 'self_balancer',
  chassis: {
    shape: 'vertical_plate',
    size: { x: 80, y: 200, z: 2 },
    thickness: 2,
    color: '#ff6f00',
    label: 'Self-balancing 2-wheel chassis',
    mounts: [
      { role: 'motor_left', at: { x: -10, y: 43, z: -12 }, rotY: 0 },
      { role: 'motor_right', at: { x: -10, y: 43, z: 12 }, rotY: 0 },
      { role: 'wheel_left', at: { x: -10, y: 43, z: -32 }, rotY: 90 },
      { role: 'wheel_right', at: { x: -10, y: 43, z: 32 }, rotY: 90 },
      { role: 'imu', at: { x: 0, y: 150, z: 6 }, rotY: 0 },
      { role: 'battery', at: { x: 10, y: 22, z: -6 } },
      { role: 'controller', at: { x: -5, y: 90, z: 6 }, rotY: 0 },
      { role: 'sensor_front', at: { x: 30, y: 140, z: 12 }, rotY: 0 },
    ],
  },
  wheel: { diameterMm: 85, widthMm: 20, tireColor: '#1a1a1a' },
  kinematics: {
    model: 'inverted_pendulum',
    wheelbaseMm: 64,
    deadbandRps: 0.02,
    gravity: 9810,
    balancePointDeg: 0,
    maxTiltDeg: 45,
    closedLoopSensors: true,
  },
  sensors: [{ role: 'imu' }, { role: 'encoder_left' }, { role: 'encoder_right' }],
  origin: { x: 0, y: 0, z: 300 },
  rotYDeg: 0,
};

const QUADCOPTER: AssemblySpecJson = {
  archetype: 'quadcopter',
  chassis: {
    shape: 'frame',
    size: { x: 250, y: 20, z: 250 },
    thickness: 4,
    color: '#222222',
    label: 'Quadcopter X-frame',
    mounts: [
      { role: 'motor_1', at: { x: 80, y: 14, z: 80 }, rotY: 0 },
      { role: 'motor_2', at: { x: 80, y: 14, z: -80 }, rotY: 0 },
      { role: 'motor_3', at: { x: -80, y: 14, z: -80 }, rotY: 0 },
      { role: 'motor_4', at: { x: -80, y: 14, z: 80 }, rotY: 0 },
      { role: 'controller', at: { x: 0, y: 6, z: 0 } },
      { role: 'battery', at: { x: -50, y: 2, z: 0 } },
      { role: 'imu', at: { x: 0, y: 10, z: 0 } },
    ],
  },
  wheel: { diameterMm: 127, widthMm: 8, tireColor: '#1a1a1a', color: '#555555' },
  kinematics: {
    model: 'quadcopter',
    wheelbaseMm: 226,
    deadbandRps: 0.5,
    gravity: 9810,
    liftK: 0.003,
    massKg: 0.8,
    closedLoopSensors: true,
  },
  sensors: [{ role: 'imu' }],
  origin: { x: 0, y: 80, z: 300 },
  rotYDeg: 0,
};

const MECANUM: AssemblySpecJson = {
  archetype: 'mecanum',
  chassis: {
    shape: 'horizontal_plate',
    size: { x: 300, y: 3, z: 200 },
    thickness: 3,
    color: '#455a64',
    label: 'Mecanum omnidirectional base',
    mounts: [
      { role: 'motor_fl', at: { x: 120, y: 45, z: 90 }, rotY: 90 },
      { role: 'motor_fr', at: { x: 120, y: 45, z: -90 }, rotY: 90 },
      { role: 'motor_rl', at: { x: -120, y: 45, z: 90 }, rotY: 90 },
      { role: 'motor_rr', at: { x: -120, y: 45, z: -90 }, rotY: 90 },
      { role: 'wheel_fl', at: { x: 120, y: 45, z: 118 } },
      { role: 'wheel_fr', at: { x: 120, y: 45, z: -118 } },
      { role: 'wheel_rl', at: { x: -120, y: 45, z: 118 } },
      { role: 'wheel_rr', at: { x: -120, y: 45, z: -118 } },
      { role: 'controller', at: { x: 0, y: 35, z: 0 } },
      { role: 'battery', at: { x: -70, y: 30, z: 0 } },
    ],
  },
  wheel: { diameterMm: 100, widthMm: 36, tireColor: '#333333' },
  kinematics: {
    model: 'mecanum',
    wheelbaseMm: 180,
    trackMm: 240,
    deadbandRps: 0.05,
  },
  origin: { x: -100, y: 5, z: 300 },
};

const STATIC_BENCH: AssemblySpecJson = {
  archetype: 'static_bench',
  kinematics: { model: 'static' },
};

const TABLE: Record<AssemblyArchetypeId, AssemblySpecJson> = {
  '2wd_rover': TWO_WD_ROVER,
  '4wd_rover': FOUR_WD_ROVER,
  self_balancer: SELF_BALANCER,
  quadcopter: QUADCOPTER,
  mecanum: MECANUM,
  static_bench: STATIC_BENCH,
};

/** Velxio accepts these aliases too (`smart_car`, `car`, `drone`, …). */
const ALIASES: Record<string, AssemblyArchetypeId> = {
  smart_car: '2wd_rover',
  car: '2wd_rover',
  tank: '4wd_rover',
  balancer: 'self_balancer',
  segway: 'self_balancer',
  drone: 'quadcopter',
  static: 'static_bench',
  bench: 'static_bench',
};

export function normaliseArchetypeId(raw: string | undefined | null): AssemblyArchetypeId | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if ((ASSEMBLY_ARCHETYPE_IDS as readonly string[]).includes(key)) return key as AssemblyArchetypeId;
  return ALIASES[key] ?? null;
}

/** A deep copy of the archetype base — callers may mutate freely. */
export function getArchetypeBase(id: AssemblyArchetypeId): AssemblySpecJson {
  return JSON.parse(JSON.stringify(TABLE[id])) as AssemblySpecJson;
}

/** One-line descriptions for the model prompt. */
export function describeArchetypes(): string {
  return [
    '2wd_rover — two-wheel differential-drive RC car / rover (deck + 2 drive motors + caster + wheels)',
    '4wd_rover — four-motor skid-steer rover / off-road car',
    'self_balancer — two-wheel self-balancing robot (Segway-style, needs an IMU)',
    'quadcopter — four-BLDC drone with propellers',
    'mecanum — omnidirectional mecanum-wheel base (4 motors)',
    'static_bench — not a vehicle: parts stay on the bench (optionally with explicit placements)',
  ].join('\n');
}
