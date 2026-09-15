/**
 * Assembly resolution — pure functions, no model, no I/O.
 *
 * `resolveAssemblyPlan` takes whatever the model proposed (possibly nothing,
 * possibly garbage) plus the deterministic baseline, and produces the frozen
 * plan: a complete Velxio-compatible spec, bindings pruned to real instances,
 * and a world placement for every instance that fits — bound mounts, explicit
 * placements, or deck-stacked extras. Everything it repairs or drops is
 * recorded in `notes`/`warnings`, never silently.
 */

import type {
  AssemblyChassis,
  AssemblyMount,
  AssemblyPlacement,
  AssemblyRole,
  AssemblySpecJson,
  AssemblyVec3,
  ResolvedAssemblyPlan,
} from '@/types/assembly';

import { nowIso } from '@/lib/validation/time';

import { getArchetypeBase, normaliseArchetypeId, type AssemblyArchetypeId } from './archetypes';
import {
  bindRoles,
  dimsFor,
  inferArchetype,
  isAxleJoint,
  isDriveMotor,
  isPropeller,
  labelFor,
  type AssemblyRosterEntry,
} from './heuristics';
import { ASSEMBLY_ROLES, type AssemblyProposal } from './schema';

export interface ResolveContext {
  roster: AssemblyRosterEntry[];
  prompt: string;
  goal: string;
  now?: string;
}

/* -------------------------------------------------------------------------- */
/* Bounds — the bench is big, but not infinite                                 */
/* -------------------------------------------------------------------------- */

/** World placements must land within ±1.5 m; anything else is a model slip. */
const WORLD_LIMIT_MM = 1500;
/** Chassis-local mounts must land within ±1 m of the chassis origin. */
const MOUNT_LIMIT_MM = 1000;
/** No single chassis dimension may exceed 800 mm. */
const CHASSIS_LIMIT_MM = 800;

const KNOWN_ROLES = new Set<string>(ASSEMBLY_ROLES);

/**
 * Roles that rest ON a surface (lifted by half the part height). Sensors are
 * deliberately excluded: their mounts are mast/bracket positions authored at
 * the right height, not deck seats.
 */
const RIDER_ROLES: ReadonlySet<AssemblyRole> = new Set([
  'controller',
  'battery',
  'imu',
  'passenger',
]);

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampVec(value: AssemblyVec3 | undefined, limit: number): AssemblyVec3 | null {
  if (!value || !finite(value.x) || !finite(value.y) || !finite(value.z)) return null;
  if (Math.abs(value.x) > limit || Math.abs(value.y) > limit || Math.abs(value.z) > limit) return null;
  return { x: value.x, y: value.y, z: value.z };
}

/** Chassis-local → world, rotating by the initial heading. */
function toWorld(at: AssemblyVec3, origin: AssemblyVec3, rotYDeg: number): AssemblyVec3 {
  const theta = (rotYDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return {
    x: origin.x + at.x * cos + at.z * sin,
    y: origin.y + at.y,
    z: origin.z - at.x * sin + at.z * cos,
  };
}

/** World → chassis-local, the exact inverse of toWorld. */
function toLocal(seat: AssemblyVec3, origin: AssemblyVec3, rotYDeg: number): AssemblyVec3 {
  const theta = (rotYDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const dx = seat.x - origin.x;
  const dz = seat.z - origin.z;
  return {
    x: dx * cos - dz * sin,
    y: seat.y - origin.y,
    z: dx * sin + dz * cos,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Top surface a rider rests on, chassis-local. Null when lifts don't apply.
 * Mirrors the Velxio chassis renderer: large flat plates grow a second deck
 * on standoffs (riders sit on top of it), frames carry parts on the hub/pods.
 */
function riderSurfaceY(chassis: AssemblyChassis | undefined): number | null {
  if (!chassis) return null;
  if (chassis.shape === 'horizontal_plate') {
    const t = chassis.thickness ?? 2;
    if (chassis.size.x > 180 && chassis.size.z > 100) return t + 18 + t / 2;
    return t;
  }
  if (chassis.shape === 'box') return chassis.size.y;
  if (chassis.shape === 'frame') return chassis.size.y / 2 + 7;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Merging                                                                     */
/* -------------------------------------------------------------------------- */

function validChassis(raw: AssemblyProposal['chassis'], notes: string[]): AssemblyChassis | null {
  if (!raw) return null;
  const size = clampVec(raw.size, CHASSIS_LIMIT_MM);
  if (!size || size.x <= 0 || size.y <= 0 || size.z <= 0) {
    notes.push('The proposed chassis size was out of bounds — the base archetype chassis was kept.');
    return null;
  }
  const mounts: AssemblyMount[] = [];
  for (const mount of raw.mounts) {
    const at = clampVec(mount.at, MOUNT_LIMIT_MM);
    if (!KNOWN_ROLES.has(mount.role) || !at) continue;
    mounts.push({ role: mount.role, at, ...(finite(mount.rotY) ? { rotY: mount.rotY } : {}) });
  }
  if (mounts.length === 0) {
    notes.push('The proposed chassis had no usable mounts — the base archetype chassis was kept.');
    return null;
  }
  return {
    shape: raw.shape,
    size,
    ...(finite(raw.thickness) ? { thickness: raw.thickness } : {}),
    ...(raw.color ? { color: raw.color } : {}),
    ...(raw.label ? { label: raw.label } : {}),
    mounts,
    ...(raw.meshUrl ? { meshUrl: raw.meshUrl } : {}),
  };
}

/**
 * The parametric extras spec (wheels — or the propeller disc on flying
 * frames). The archetype default wins unless the model sizes them; anything
 * out of range is dropped with a note, never silently.
 */
function mergeWheelSpec(
  base: AssemblySpecJson['wheel'],
  baseId: AssemblyArchetypeId,
  override: AssemblyProposal['wheel'],
  notes: string[],
): AssemblySpecJson['wheel'] {
  if (baseId === 'static_bench') {
    if (override && Object.keys(override).length > 0) {
      notes.push('The proposed wheel spec was ignored — a static bench has no wheels.');
    }
    return undefined;
  }
  if (!override || Object.keys(override).length === 0) return base;
  const merged: NonNullable<AssemblySpecJson['wheel']> = { ...(base ?? { diameterMm: 65, widthMm: 26 }) };
  const bad: string[] = [];
  if (override.diameterMm !== undefined) {
    if (override.diameterMm < 20 || override.diameterMm > 300) bad.push('diameterMm');
    else merged.diameterMm = override.diameterMm;
  }
  if (override.widthMm !== undefined) {
    if (override.widthMm < 5 || override.widthMm > 120) bad.push('widthMm');
    else merged.widthMm = override.widthMm;
  }
  if (typeof override.tireColor === 'string' && override.tireColor) merged.tireColor = override.tireColor;
  if (typeof override.color === 'string' && override.color) merged.color = override.color;
  if (bad.length > 0) {
    notes.push(`The proposed wheel ${bad.join(' and ')} was out of range (⌀20–300 mm, width 5–120 mm) — the valid parts were kept.`);
    return merged;
  }
  notes.push(`Wheels sized by the model: ⌀${Math.round(merged.diameterMm)} × ${Math.round(merged.widthMm)} mm.`);
  return merged;
}

/** Merge proposal mounts over the base: same role replaces, `passenger` appends. */
function mergeMounts(base: AssemblyMount[], extra: AssemblyProposal['mounts'], notes: string[]): AssemblyMount[] {
  if (!extra || extra.length === 0) return base;
  const merged = base.filter(
    (mount) => mount.role === 'passenger' || !extra.some((candidate) => candidate.role === mount.role),
  );
  let dropped = 0;
  for (const mount of extra) {
    const at = clampVec(mount.at, MOUNT_LIMIT_MM);
    if (!KNOWN_ROLES.has(mount.role) || !at) {
      dropped += 1;
      continue;
    }
    merged.push({ role: mount.role, at, ...(finite(mount.rotY) ? { rotY: mount.rotY } : {}) });
  }
  if (dropped > 0) notes.push(`${dropped} proposed mount(s) were out of bounds and were dropped.`);
  return merged;
}

/* -------------------------------------------------------------------------- */
/* Deck stacking — seating the parts no named mount covers                     */
/* -------------------------------------------------------------------------- */

/**
 * A part already seated, in chassis-local coordinates — deck-stacking steers
 * around these footprints so cargo never lands inside a mounted part.
 */
interface StackBlock {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  l: number;
}

/**
 * Local positions for unbound parts: a grid on the deck top (or the plate
 * face for a vertical chassis), steering around already-seated parts.
 * Deterministic by instance id.
 */
function stackLocal(
  chassis: AssemblyChassis,
  parts: AssemblyRosterEntry[],
  warnings: string[],
  blocked: StackBlock[] = [],
): { id: string; at: AssemblyVec3 }[] {
  const sorted = [...parts].sort((a, b) => a.id.localeCompare(b.id));
  const out: { id: string; at: AssemblyVec3 }[] = [];
  const margin = 14;
  const clearance = 6;
  const taken: StackBlock[] = [...blocked];
  const collides = (
    a: number,
    b: number,
    w: number,
    len: number,
    plane: 'xz' | 'xy',
  ): boolean =>
    taken.some((block) => {
      const bl = plane === 'xz' ? block.l : block.h;
      const bs = plane === 'xz' ? block.z : block.y;
      return (
        Math.abs(a - block.x) < (w + block.w) / 2 + clearance &&
        Math.abs(b - bs) < (len + bl) / 2 + clearance
      );
    });
  /**
   * First free cell in the (a, b) rect, row-major from the back-left, so
   * cargo tucks into whatever space the mounted parts leave — never shoved
   * off the deck by a slide cascade.
   */
  const scanGrid = (
    minA: number,
    maxA: number,
    minB: number,
    maxB: number,
    w: number,
    len: number,
    plane: 'xz' | 'xy',
  ): { a: number; b: number } | null => {
    const stepA = Math.max(12, w / 2);
    const stepB = Math.max(12, len / 2);
    for (let b = minB + len / 2; b + len / 2 <= maxB + 1; b += stepB) {
      for (let a = minA + w / 2; a + w / 2 <= maxA + 1; a += stepA) {
        if (!collides(a, b, w, len, plane)) return { a, b };
      }
    }
    return null;
  };

  if (chassis.shape === 'vertical_plate') {
    const faceZ = (chassis.thickness ?? 2) / 2;
    const minX = -chassis.size.x / 2 + margin;
    const maxX = chassis.size.x / 2 - margin;
    let crowded = 0;
    for (const part of sorted) {
      // The face grid starts above the motors (axle height + motor half).
      const cell = scanGrid(minX, maxX, 56, chassis.size.y - margin, part.dims.w, part.dims.h, 'xy');
      const cx = cell ? cell.a : minX + part.dims.w / 2;
      const cy = cell ? cell.b : 56;
      if (!cell) crowded += 1;
      out.push({ id: part.id, at: { x: cx, y: cy, z: faceZ + part.dims.l / 2 } });
      taken.push({ x: cx, y: cy, z: faceZ, w: part.dims.w, h: part.dims.h, l: part.dims.l });
    }
    if (crowded > 0) warnings.push(`${crowded} part(s) overlap seated parts — the balancer plate is crowded.`);
    return out;
  }

  if (chassis.shape === 'custom_mesh') return out;

  // horizontal_plate / box / frame: grid on the top surface.
  const surfaceY = riderSurfaceY(chassis) ?? chassis.size.y;
  const minX = -chassis.size.x / 2 + margin;
  const maxX = chassis.size.x / 2 - margin;
  const minZ = -chassis.size.z / 2 + margin;
  const maxZ = chassis.size.z / 2 - margin;
  let crowded = 0;
  for (const part of sorted) {
    const cell = scanGrid(minX, maxX, minZ, maxZ, part.dims.w, part.dims.l, 'xz');
    const cx = cell ? cell.a : minX + part.dims.w / 2;
    const cz = cell ? cell.b : minZ + part.dims.l / 2;
    if (!cell) crowded += 1;
    out.push({ id: part.id, at: { x: cx, y: surfaceY + part.dims.h / 2, z: cz } });
    taken.push({ x: cx, y: surfaceY, z: cz, w: part.dims.w, h: part.dims.h, l: part.dims.l });
  }
  if (crowded > 0) warnings.push(`${crowded} part(s) overlap seated parts — the deck is crowded for this build.`);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Overlap reporting                                                           */
/* -------------------------------------------------------------------------- */

function findOverlaps(
  placements: Record<string, AssemblyPlacement>,
  roster: Map<string, AssemblyRosterEntry>,
): string[] {
  const ids = Object.keys(placements);
  const hits: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = placements[ids[i]!]!;
      const b = placements[ids[j]!]!;
      const da = roster.get(ids[i]!);
      const db = roster.get(ids[j]!);
      if (!da || !db) continue;
      if (isAxleJoint(da.ref, db.ref)) continue;
      const overlapX = Math.abs(a.x - b.x) < (da.dims.w + db.dims.w) / 2;
      const overlapZ = Math.abs(a.z - b.z) < (da.dims.l + db.dims.l) / 2;
      const overlapY = Math.abs(a.y - b.y) < ((da.dims.h + db.dims.h) / 2) * 0.8;
      if (overlapX && overlapY && overlapZ) hits.push(`${da.name} overlaps ${db.name}`);
    }
  }
  return hits;
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

export interface ResolvedAssembly {
  plan: ResolvedAssemblyPlan;
  /** True when the model's proposal contributed (not pure heuristic). */
  usedModel: boolean;
}

export function resolveAssemblyPlan(proposal: AssemblyProposal | null, context: ResolveContext): ResolvedAssembly {
  const notes: string[] = [];
  const warnings: string[] = [];
  const byId = new Map(context.roster.map((entry) => [entry.id, entry]));
  const usedModel = proposal !== null;

  const guess = inferArchetype(context.roster, context.prompt);
  let baseId: AssemblyArchetypeId = guess.archetype;
  if (proposal?.archetype) {
    const wanted = normaliseArchetypeId(proposal.archetype);
    if (wanted) {
      baseId = wanted;
      if (wanted !== guess.archetype) {
        notes.push(`The model chose ${wanted} over the deterministic ${guess.archetype} (${guess.reason}).`);
      }
    } else {
      notes.push(`Unknown archetype "${proposal.archetype}" — fell back to ${guess.archetype} (${guess.reason}).`);
    }
  } else if (!usedModel) {
    notes.push(`Archetype ${guess.archetype}: ${guess.reason}.`);
  }

  const base = getArchetypeBase(baseId);
  const customChassis = proposal?.chassis ? validChassis(proposal.chassis, notes) : null;
  if (proposal?.chassis && customChassis) notes.push('Custom chassis authored by the model.');
  const chassis: AssemblyChassis | undefined = customChassis ?? base.chassis;
  if (chassis && proposal?.mounts?.length) {
    chassis.mounts = mergeMounts(chassis.mounts, proposal.mounts, notes);
  }
  const mountedRoles = new Set((chassis?.mounts ?? []).map((mount) => mount.role));

  // Bindings: the model's first (pruned to roster + mounted roles), then the
  // heuristic fills whatever roles are still empty.
  const locked: Partial<Record<AssemblyRole, string>> = {};
  if (proposal?.bindings) {
    for (const [role, id] of Object.entries(proposal.bindings)) {
      if (!KNOWN_ROLES.has(role)) {
        notes.push(`Binding to unknown role "${role}" was dropped.`);
        continue;
      }
      if (typeof id !== 'string' || !byId.has(id)) {
        notes.push(`Binding "${role}" references "${id}", which is not in this build — dropped.`);
        continue;
      }
      if (!mountedRoles.has(role as AssemblyRole)) {
        notes.push(`Binding "${role}" has no mount on this chassis — dropped (the part is deck-stacked instead).`);
        continue;
      }
      locked[role as AssemblyRole] = id;
    }
  }
  const bindings = bindRoles({ archetype: baseId, roster: context.roster, locked });
  // The heuristic may bind roles this chassis does not mount (custom chassis).
  for (const role of Object.keys(bindings) as AssemblyRole[]) {
    if (!mountedRoles.has(role)) delete bindings[role];
  }

  // The parametric extras: wheels/casters/propellers the electrical roster
  // cannot supply. The scene draws them from the spec at every mount no real
  // part claims, so the product shape is complete even with no wheel parts —
  // and the plan says so honestly.
  const wheel = mergeWheelSpec(base.wheel, baseId, proposal?.wheel, notes);
  const unboundWheels = (chassis?.mounts ?? []).filter(
    (mount) => mount.role.startsWith('wheel_') && !bindings[mount.role as AssemblyRole],
  );
  const unboundCasters = (chassis?.mounts ?? []).filter(
    (mount) => (mount.role === 'caster_front' || mount.role === 'caster_back') && !bindings[mount.role as AssemblyRole],
  );
  const isFlyingShape = base.kinematics?.model === 'quadcopter' || base.kinematics?.model === 'hexacopter';
  const parametricRoles: string[] = [
    ...unboundWheels.map((mount) => mount.role as string),
    ...unboundCasters.map((mount) => mount.role as string),
  ];
  if (unboundWheels.length > 0) {
    notes.push(
      `${unboundWheels.length} parametric wheel${unboundWheels.length > 1 ? 's' : ''} (⌀${Math.round(wheel?.diameterMm ?? 65)} mm) render at the wheel mounts — this build has no wheel parts, the archetype supplies the shape.`,
    );
  }
  if (unboundCasters.length > 0) {
    notes.push(
      `${unboundCasters.length} caster${unboundCasters.length > 1 ? 's' : ''} render parametrically at the caster mount${unboundCasters.length > 1 ? 's' : ''} — no caster part in this build.`,
    );
  }
  if (isFlyingShape && chassis) {
    const rotors = (chassis.mounts ?? []).filter((mount) => mount.role.startsWith('motor_'));
    if (rotors.length > 0 && !context.roster.some(isPropeller)) {
      parametricRoles.push(...rotors.map((mount) => mount.role as string));
      notes.push(
        `${rotors.length} propeller${rotors.length > 1 ? 's' : ''} render parametrically on the motors — this build has no propeller parts.`,
      );
    }
  }

  const origin = (proposal?.origin ? clampVec(proposal.origin, WORLD_LIMIT_MM) : null) ??
    base.origin ?? { x: 0, y: 0, z: 0 };
  if (proposal?.origin && !clampVec(proposal.origin, WORLD_LIMIT_MM)) {
    notes.push('The proposed origin was out of bounds — the archetype origin was kept.');
  }
  const rotYDeg = finite(proposal?.rotYDeg) ? (proposal.rotYDeg as number) : (base.rotYDeg ?? 0);

  const placements: Record<string, AssemblyPlacement> = {};
  const mountByRole = new Map((chassis?.mounts ?? []).map((mount) => [mount.role, mount]));
  const surfaceY = riderSurfaceY(chassis);

  // 1. Bound mounts → world placements.
  for (const [role, id] of Object.entries(bindings) as [AssemblyRole, string][]) {
    const mount = mountByRole.get(role);
    const entry = byId.get(id);
    if (!mount || !entry) continue;
    const lift = RIDER_ROLES.has(role) && surfaceY !== null ? Math.max(0, surfaceY + entry.dims.h / 2 - mount.at.y) : 0;
    const world = toWorld({ x: mount.at.x, y: mount.at.y + lift, z: mount.at.z }, origin, rotYDeg);
    placements[id] = { x: world.x, y: world.y, z: world.z, rotY: (mount.rotY ?? 0) + rotYDeg };
  }

  // 2. Explicit model placements (static builds, or extras the model seated by hand).
  if (proposal?.placements) {
    for (const [id, raw] of Object.entries(proposal.placements)) {
      const entry = byId.get(id);
      if (!entry) {
        notes.push(`Placement for "${id}", which is not in this build — dropped.`);
        continue;
      }
      if (placements[id]) {
        notes.push(`${entry.name} is already seated on a mount — the explicit placement was ignored.`);
        continue;
      }
      if (!finite(raw.x) || !finite(raw.y) || !finite(raw.z)) {
        notes.push(`Placement for ${entry.name} was not finite — dropped.`);
        continue;
      }
      if (Math.abs(raw.x) > WORLD_LIMIT_MM || raw.y < 0 || raw.y > 800 || Math.abs(raw.z) > WORLD_LIMIT_MM) {
        notes.push(`Placement for ${entry.name} was out of bounds — dropped.`);
        continue;
      }
      placements[id] = { x: raw.x, y: raw.y, z: raw.z, rotY: finite(raw.rotY) ? (raw.rotY as number) : 0 };
    }
  }

  // 3. Everything still unseated rides on the deck (vehicles only).
  const parametric: string[] = [];
  const isFlying = base.kinematics?.model === 'quadcopter' || base.kinematics?.model === 'hexacopter';
  const leftovers = context.roster.filter((entry) => !placements[entry.id]);
  if (chassis) {
    // Propellers seat on their motors in rotor order (drones only).
    if (isFlying) {
      const motorMounts = (chassis.mounts ?? [])
        .filter((mount) => mount.role.startsWith('motor_'))
        .sort((a, b) => a.role.localeCompare(b.role));
      let propSlot = 0;
      let seatedProps = 0;
      for (const entry of leftovers) {
        if (!isPropeller(entry) || placements[entry.id]) continue;
        const slot = motorMounts[propSlot];
        const motorId = slot ? bindings[slot.role] : undefined;
        const motor = motorId ? byId.get(motorId) : undefined;
        if (!slot || !motor) continue;
        const world = toWorld(
          {
            x: slot.at.x,
            y: slot.at.y + motor.dims.h / 2 + entry.dims.h / 2 + 2,
            z: slot.at.z,
          },
          origin,
          rotYDeg,
        );
        placements[entry.id] = { x: world.x, y: world.y, z: world.z, rotY: rotYDeg };
        propSlot += 1;
        seatedProps += 1;
      }
      if (seatedProps > 0) notes.push(`${seatedProps} propeller(s) seated on the drone's motors.`);
    }
    const stackable = leftovers.filter((entry) => !placements[entry.id]);
    if (stackable.length > 0) {
      if (chassis.shape === 'custom_mesh') {
        notes.push(`${stackable.length} part(s) have nowhere to sit on a custom-mesh chassis — bench grid.`);
      } else {
        const blocked: StackBlock[] = [];
        for (const [id, seat] of Object.entries(placements)) {
          const entry = byId.get(id);
          if (!entry) continue;
          const local = toLocal({ x: seat.x, y: seat.y, z: seat.z }, origin, rotYDeg);
          blocked.push({ x: local.x, y: local.y, z: local.z, w: entry.dims.w, h: entry.dims.h, l: entry.dims.l });
        }
        for (const slot of stackLocal(chassis, stackable, warnings, blocked)) {
          const world = toWorld(slot.at, origin, rotYDeg);
          placements[slot.id] = { x: world.x, y: world.y, z: world.z, rotY: rotYDeg };
        }
        notes.push(`${stackable.length} extra part(s) deck-stacked on the ${baseId}.`);
      }
    }
  } else if (leftovers.length > 0) {
    notes.push(`${leftovers.length} part(s) stay in the bench grid (static build).`);
  }

  const unplaced = context.roster
    .filter((entry) => !placements[entry.id] && !parametric.includes(entry.id))
    .map((entry) => entry.id);

  for (const hit of findOverlaps(placements, byId).slice(0, 5)) warnings.push(`Possible 3D overlap: ${hit}.`);

  // The pushed spec carries EXACT mounts. The scene re-poses bound parts from
  // the mounts every frame, so each bound mount is rewritten to the resolved
  // part centre (chassis-local). Placed-but-unbound parts (deck cargo, model
  // extras, propellers) get `passenger_N` follower seats so the chassis
  // carries them when it drives. Deterministic by instance id.
  const MAX_FOLLOWERS = 8;
  if (chassis) {
    for (const [role, id] of Object.entries(bindings) as [AssemblyRole, string][]) {
      const seat = placements[id];
      const mount = (chassis.mounts ?? []).find((candidate) => candidate.role === role);
      if (!seat || !mount) continue;
      const local = toLocal({ x: seat.x, y: seat.y, z: seat.z }, origin, rotYDeg);
      mount.at = { x: round2(local.x), y: round2(local.y), z: round2(local.z) };
      mount.rotY = round2((seat.rotY ?? 0) - rotYDeg);
    }
    const boundIds = new Set(Object.values(bindings));
    const followers = Object.keys(placements)
      .filter((id) => !boundIds.has(id))
      .sort();
    let emitted = 0;
    for (const id of followers) {
      if (emitted >= MAX_FOLLOWERS) {
        notes.push(
          `${followers.length - emitted} extra part(s) have no follower seat — they stay where the build baked them.`,
        );
        break;
      }
      const seat = placements[id]!;
      const local = toLocal({ x: seat.x, y: seat.y, z: seat.z }, origin, rotYDeg);
      const role = `passenger_${emitted}` as AssemblyRole;
      chassis.mounts = [
        ...(chassis.mounts ?? []),
        {
          role,
          at: { x: round2(local.x), y: round2(local.y), z: round2(local.z) },
          rotY: round2((seat.rotY ?? 0) - rotYDeg),
        },
      ];
      bindings[role] = id;
      emitted += 1;
    }
    if (emitted > 0) {
      // A bare `passenger` mount would double-pose the first follower (the
      // scene resolves it to the first `passenger_N` binding), so unbound
      // ones leave the pushed spec.
      chassis.mounts = (chassis.mounts ?? []).filter(
        (mount) => mount.role !== 'passenger' || bindings[mount.role] !== undefined,
      );
    }
  }

  const spec: AssemblySpecJson = {
    ...(base.archetype ? { archetype: base.archetype } : {}),
    ...(chassis ? { chassis } : {}),
    ...(wheel ? { wheel } : {}),
    kinematics: base.kinematics,
    ...(base.sensors ? { sensors: base.sensors } : {}),
    ...(Object.keys(bindings).length > 0 ? { bindings: { ...bindings } } : {}),
    origin,
    rotYDeg,
    meta: { source: usedModel ? 'model' : 'heuristic', baseArchetype: baseId },
  };

  const label = proposal?.label?.trim() || labelFor(baseId, context.goal);
  if (proposal?.notes?.trim()) notes.push(`Model: ${proposal.notes.trim()}`);

  return {
    usedModel,
    plan: {
      version: 1,
      archetype: baseId,
      label,
      source: usedModel ? 'model' : 'heuristic',
      spec,
      bindings,
      placements,
      parametric,
      parametricRoles,
      unplaced,
      notes,
      warnings,
      createdAt: context.now ?? nowIso(),
    },
  };
}

/** The deterministic plan: no model output, baseline only. */
export function heuristicAssembly(context: ResolveContext): ResolvedAssemblyPlan {
  return resolveAssemblyPlan(null, context).plan;
}

/**
 * Prune a plan to the instances that still exist (fixes that remove parts,
 * canvas syncs). Keeps placements for surviving ids; pruned ids simply leave
 * the scene instead of pointing at ghosts.
 */
export function pruneAssemblyToIds(
  plan: ResolvedAssemblyPlan,
  validIds: ReadonlySet<string>,
): { plan: ResolvedAssemblyPlan; dropped: string[] } {
  const dropped: string[] = [];
  const bindings = { ...plan.bindings };
  for (const [role, id] of Object.entries(bindings) as [AssemblyRole, string | undefined][]) {
    if (id && !validIds.has(id)) {
      dropped.push(`${role}→${id}`);
      delete bindings[role];
    }
  }
  const placements: Record<string, AssemblyPlacement> = {};
  for (const [id, placement] of Object.entries(plan.placements)) {
    if (validIds.has(id)) placements[id] = placement;
    else dropped.push(`placement:${id}`);
  }
  const parametric = plan.parametric.filter((id) => {
    if (validIds.has(id)) return true;
    dropped.push(`parametric:${id}`);
    return false;
  });
  const unplaced = plan.unplaced.filter((id) => validIds.has(id));
  // `parametricRoles` are mount roles, not instance ids — the scene still
  // draws wheels/casters/props for whatever instances survive.
  if (dropped.length === 0) return { plan, dropped };
  const next: ResolvedAssemblyPlan = {
    ...plan,
    bindings,
    placements,
    parametric,
    unplaced,
    spec: { ...plan.spec, bindings: { ...bindings } },
  };
  return { plan: next, dropped };
}

/**
 * Translate diagram ids to Velxio ids for the pushed spec. The controller is
 * a board in Velxio, not a component, so its diagram id becomes the board id;
 * every other part keeps its id.
 */
export function translateAssemblyForVlx(
  plan: ResolvedAssemblyPlan,
  toVlxId: (diagramId: string) => string,
): AssemblySpecJson {
  const bindings: Partial<Record<AssemblyRole, string>> = {};
  for (const [role, id] of Object.entries(plan.bindings) as [AssemblyRole, string | undefined][]) {
    if (id) bindings[role] = toVlxId(id);
  }
  return { ...plan.spec, bindings };
}

/** Roster helper shared by the pipeline, the bundle and the verify script. */
export function rosterEntryFor(
  id: string,
  ref: string,
  name: string,
  category: AssemblyRosterEntry['category'],
  label?: string,
): AssemblyRosterEntry {
  return { id, ref, name, category, ...(label ? { label } : {}), dims: dimsFor(ref) };
}

/** True when the build has anything worth assembling (at least one part). */
export function hasSeatables(roster: AssemblyRosterEntry[]): boolean {
  return roster.length > 0 && roster.some((entry) => entry.category !== 'prototyping' || roster.length === 1);
}

export { isDriveMotor };
