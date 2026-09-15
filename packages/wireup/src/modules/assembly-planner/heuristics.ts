/**
 * Assembly heuristics — the deterministic baseline the model refines.
 *
 * Two jobs: (1) infer which vehicle archetype a build is, from the catalog
 * ids the pipeline selected; (2) bind diagram instances to mount roles.
 * Both run with no model and no network, so every project gets a shape even
 * when Bedrock is down — and when the model IS up, these fill any role the
 * model left unbound rather than leaving a motor off the chassis.
 */

import type { ComponentCategory } from '@/types/component';
import type { AssemblyRole } from '@/types/assembly';

import { getSeedComponent } from '@/modules/components/catalog';

import type { AssemblyArchetypeId } from './archetypes';

/** One seatable instance: a diagram component plus its physical footprint. */
export interface AssemblyRosterEntry {
  /** Diagram component id (== the Velxio component id for parts). */
  id: string;
  /** Catalog definition id. */
  ref: string;
  name: string;
  category: ComponentCategory;
  label?: string;
  /** Footprint in mm. Catalog truth where the seed states it, a documented
   *  layout default otherwise — used ONLY for spacing parts, never reported
   *  as a specification. */
  dims: { w: number; l: number; h: number };
}

/** Layout-only fallback footprint when the seed states no dimensions. */
export const DEFAULT_FOOTPRINT = { w: 40, l: 40, h: 12 } as const;

export function dimsFor(ref: string): { w: number; l: number; h: number } {
  const raw = getSeedComponent(ref)?.metadata?.dimensionsMm as
    | { width?: unknown; length?: unknown; height?: unknown }
    | undefined;
  const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  return {
    w: num(raw?.width) ?? DEFAULT_FOOTPRINT.w,
    l: num(raw?.length) ?? DEFAULT_FOOTPRINT.l,
    h: num(raw?.height) ?? DEFAULT_FOOTPRINT.h,
  };
}

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

function haystack(entry: AssemblyRosterEntry): string {
  return `${entry.ref} ${entry.name} ${entry.label ?? ''}`.toLowerCase();
}

/** Not a drive motor: spins air/fluid or shakes, never a wheel. */
function isFanPump(entry: AssemblyRosterEntry): boolean {
  return /fan|blower|pump|vibration/.test(haystack(entry));
}

function isBldc(entry: AssemblyRosterEntry): boolean {
  return /bldc|brushless/.test(entry.ref.toLowerCase());
}

function isContinuousServo(entry: AssemblyRosterEntry): boolean {
  return /fs90r|continuous/.test(haystack(entry));
}

function isStepper(entry: AssemblyRosterEntry): boolean {
  return /stepper|28byj|nema/.test(haystack(entry));
}

function isPositionalServo(entry: AssemblyRosterEntry): boolean {
  return entry.category === 'motor' && /servo/.test(entry.ref.toLowerCase()) && !isContinuousServo(entry);
}

/** A motor that can turn a wheel: brushed DC / gear motors first, then the rest. */
export function driveRank(entry: AssemblyRosterEntry): number {
  if (entry.category !== 'motor' || isFanPump(entry)) return -1;
  if (isBldc(entry)) return 0;
  if (/dc-motor|n20|gear-motor|tt-motor|motor-generic/.test(entry.ref.toLowerCase())) return 1;
  if (isContinuousServo(entry)) return 2;
  if (isStepper(entry)) return 3;
  if (isPositionalServo(entry)) return 4;
  return 1;
}

export function isDriveMotor(entry: AssemblyRosterEntry): boolean {
  return driveRank(entry) >= 0;
}

export function isPropeller(entry: AssemblyRosterEntry): boolean {
  return /propeller/.test(entry.ref.toLowerCase());
}

export function isWheel(entry: AssemblyRosterEntry): boolean {
  // Diagram wheels carry no dedicated category — match by ref/name, but a
  // motor kit with "wheel" in its name is still a motor, not a wheel.
  if (entry.category === 'motor' || isPropeller(entry)) return false;
  return /wheel|tire|tt-wheel/.test(haystack(entry));
}

export function isCaster(entry: AssemblyRosterEntry): boolean {
  return /caster/.test(haystack(entry));
}

/**
 * A wheel/caster/prop seated ON its motor shaft: the two boxes interpenetrate
 * by design, so overlap checks must not report the pair.
 */
export function isAxleJoint(refA: string, refB: string): boolean {
  const spun = /wheel|tire|caster|propeller/i;
  const spinner = /motor|bldc|servo|n20|tt-motor|gear-motor/i;
  return (spun.test(refA) && spinner.test(refB)) || (spun.test(refB) && spinner.test(refA));
}

export function isImu(entry: AssemblyRosterEntry): boolean {
  return /mpu6050|mpu9250|\bimu\b|bmi\d/.test(haystack(entry));
}

export function isRangefinder(entry: AssemblyRosterEntry): boolean {
  return /hc-sr04|ultrasonic|vl53|lidar|ir-obstacle/.test(haystack(entry));
}

export function isBattery(entry: AssemblyRosterEntry): boolean {
  if (entry.category !== 'power') return false;
  return /battery|lipo|li-ion|2s|9v|4xaa|holder/.test(haystack(entry));
}

export function isDriver(entry: AssemblyRosterEntry): boolean {
  return entry.category === 'motor_driver';
}

export function isMcu(entry: AssemblyRosterEntry): boolean {
  return entry.category === 'microcontroller';
}

/* -------------------------------------------------------------------------- */
/* Archetype inference                                                         */
/* -------------------------------------------------------------------------- */

export interface ArchetypeGuess {
  archetype: AssemblyArchetypeId;
  reason: string;
}

const CAR_WORDS = /rc\b|radio.control|remote.control|\bcar\b|rover|robot|vehicle|chassis|tank|buggy|\bdrive\b|wheels?/;
const DRONE_WORDS = /drone|quadcopter|quad-copter|multicopter|uav|\bfly\b|flying|hexacopter/;
const BALANCER_WORDS = /balanc|segway|self-balanc|two-wheel|inverted pendulum/;
const BOAT_WORDS = /boat|ship|submarine|rov/;

export function inferArchetype(roster: AssemblyRosterEntry[], promptText = ''): ArchetypeGuess {
  const prompt = promptText.toLowerCase();
  const drives = roster.filter(isDriveMotor).sort((a, b) => driveRank(a) - driveRank(b));
  const bldcs = drives.filter(isBldc);
  const imus = roster.filter(isImu);
  const nonBldcDrives = drives.filter((entry) => !isBldc(entry));

  if (BOAT_WORDS.test(prompt)) {
    return { archetype: 'static_bench', reason: 'a watercraft shape has no vehicle archetype yet — bench layout' };
  }
  if ((bldcs.length >= 4 || (bldcs.length >= 2 && DRONE_WORDS.test(prompt))) && !CAR_WORDS.test(prompt)) {
    return {
      archetype: 'quadcopter',
      reason: `${bldcs.length} brushless motor(s)${DRONE_WORDS.test(prompt) ? ' and a flight brief' : ''} read as a drone`,
    };
  }
  if (nonBldcDrives.length >= 2 && imus.length >= 1 && (BALANCER_WORDS.test(prompt) || !CAR_WORDS.test(prompt))) {
    return {
      archetype: 'self_balancer',
      reason: `${nonBldcDrives.length} drive motor(s) + an IMU${BALANCER_WORDS.test(prompt) ? ' and a balancing brief' : ''} read as a self-balancing bot`,
    };
  }
  if (nonBldcDrives.length >= 4) {
    return { archetype: '4wd_rover', reason: `${nonBldcDrives.length} drive motors read as a 4WD rover` };
  }
  if (nonBldcDrives.length >= 2) {
    return {
      archetype: '2wd_rover',
      reason: `${nonBldcDrives.length} drive motors${CAR_WORDS.test(prompt) ? ' and a driving brief' : ''} read as an RC car (2WD rover)`,
    };
  }
  if (nonBldcDrives.length === 1 && CAR_WORDS.test(prompt)) {
    return {
      archetype: '2wd_rover',
      reason: 'a driving brief with a single drive motor still reads as a small car (one side stays empty)',
    };
  }
  return { archetype: 'static_bench', reason: 'no drive train detected — bench layout' };
}

/* -------------------------------------------------------------------------- */
/* Heuristic role binding                                                      */
/* -------------------------------------------------------------------------- */

function prefersLeft(entry: AssemblyRosterEntry): boolean {
  return /left|\bl\b|_l\b|-1\b| 1\b/.test(haystack(entry));
}

function prefersRight(entry: AssemblyRosterEntry): boolean {
  return /right|\br\b|_r\b|-2\b| 2\b/.test(haystack(entry));
}

/** Order drive motors so index 0/1 land on left/right sensibly. */
function orderDrives(drives: AssemblyRosterEntry[]): AssemblyRosterEntry[] {
  const sorted = [...drives].sort((a, b) => driveRank(a) - driveRank(b) || a.id.localeCompare(b.id));
  if (sorted.length === 2 && prefersRight(sorted[0]!) && !prefersRight(sorted[1]!)) {
    return [sorted[1]!, sorted[0]!];
  }
  return sorted;
}

export interface BindingRequest {
  archetype: AssemblyArchetypeId;
  roster: AssemblyRosterEntry[];
  /** Roles already bound (e.g. by the model) — never overwritten. */
  locked?: Partial<Record<AssemblyRole, string>>;
}

/**
 * Bind instances to mount roles. Deterministic: same roster, same bindings.
 * Only binds roles the archetype's chassis actually mounts; everything else
 * is deck-stacked by the resolver.
 */
export function bindRoles(request: BindingRequest): Partial<Record<AssemblyRole, string>> {
  const locked = request.locked ?? {};
  const bindings: Partial<Record<AssemblyRole, string>> = { ...locked };
  const taken = new Set<string>(Object.values(locked).filter((id): id is string => !!id));
  const byId = new Map(request.roster.map((entry) => [entry.id, entry]));

  const free = (entry: AssemblyRosterEntry | undefined): AssemblyRosterEntry | undefined =>
    entry && !taken.has(entry.id) ? entry : undefined;
  const claim = (role: AssemblyRole, entry: AssemblyRosterEntry | undefined): void => {
    if (bindings[role] || !entry || taken.has(entry.id)) return;
    bindings[role] = entry.id;
    taken.add(entry.id);
  };
  const firstFree = (entries: AssemblyRosterEntry[]): AssemblyRosterEntry | undefined =>
    entries.map((entry) => byId.get(entry.id)).find(free);

  const drives = orderDrives(request.roster.filter(isDriveMotor));
  const bldcs = drives.filter(isBldc);
  const mcus = request.roster.filter(isMcu);
  const drivers = request.roster.filter(isDriver);
  const batteries = request.roster.filter(isBattery);
  const wheels = request.roster.filter(isWheel);
  const casters = request.roster.filter(isCaster);
  const imus = request.roster.filter(isImu);
  const rangefinders = request.roster.filter(isRangefinder);

  switch (request.archetype) {
    case '2wd_rover':
    case 'self_balancer': {
      claim('motor_left', firstFree(drives));
      claim('motor_right', firstFree(drives.filter((entry) => !taken.has(entry.id))));
      claim('wheel_left', firstFree(wheels));
      claim('wheel_right', firstFree(wheels.filter((entry) => !taken.has(entry.id))));
      break;
    }
    case '4wd_rover':
    case 'mecanum': {
      const roles: AssemblyRole[] = ['motor_fl', 'motor_fr', 'motor_rl', 'motor_rr'];
      for (const role of roles) claim(role, firstFree(drives.filter((entry) => !taken.has(entry.id))));
      const wheelRoles: AssemblyRole[] = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'];
      for (const role of wheelRoles) claim(role, firstFree(wheels.filter((entry) => !taken.has(entry.id))));
      break;
    }
    case 'quadcopter': {
      const motors = bldcs.length >= 4 ? bldcs : drives;
      const roles: AssemblyRole[] = ['motor_1', 'motor_2', 'motor_3', 'motor_4'];
      for (const role of roles) claim(role, firstFree(motors.filter((entry) => !taken.has(entry.id))));
      break;
    }
    case 'static_bench':
      return bindings;
  }

  // The brain rides in the controller seat; a motor driver is stacked cargo.
  claim('controller', firstFree(mcus));
  claim('battery', firstFree(batteries));
  claim('imu', firstFree(imus));
  claim('caster_front', firstFree(casters));
  // Only true rangefinders take the front mast — other sensors deck-stack.
  claim('sensor_front', firstFree(rangefinders));

  return bindings;
}

/** Product label from the brief goal + archetype. */
export function labelFor(archetype: AssemblyArchetypeId, goal: string): string {
  const short = goal.trim().replace(/\.$/, '').slice(0, 48);
  const shape =
    archetype === '2wd_rover'
      ? '2WD rover'
      : archetype === '4wd_rover'
        ? '4WD rover'
        : archetype === 'self_balancer'
          ? 'self-balancing bot'
          : archetype === 'quadcopter'
            ? 'quadcopter'
            : archetype === 'mecanum'
              ? 'mecanum base'
              : 'bench';
  if (archetype === 'static_bench') return 'Bench layout';
  return short.length > 0 ? `${short} — ${shape}` : shape;
}
