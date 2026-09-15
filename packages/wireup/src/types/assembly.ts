/**
 * 3D assembly types — the shape of the thing being built.
 *
 * After the pipeline selects components, the assembly planner decides how
 * those parts sit in 3D space: a vehicle archetype (an RC car prompt becomes
 * a 2WD rover, a drone prompt a quadcopter), a parametric chassis, and a
 * binding of every real diagram instance to a mount role on that chassis.
 *
 * The resolved spec is deliberately wire-compatible with Velxio's
 * `AssemblySpec` (`external/velxio/frontend/src/scene3d/assembly/`): the
 * simulation bundle translates diagram ids to Velxio ids and pushes the spec
 * straight into LiveGround, which assembles and animates the scene from it.
 * `scripts/verify-assembly.ts` holds the shared archetype tables to the
 * Velxio source so the two sides cannot drift.
 */

/** A point in millimetres. */
export interface AssemblyVec3 {
  x: number;
  y: number;
  z: number;
}

/** Mount roles LiveGround understands (mirrors Velxio's `MountPoint['role']`). */
export type AssemblyRole =
  | 'motor_left'
  | 'motor_right'
  | 'motor_fl'
  | 'motor_fr'
  | 'motor_rl'
  | 'motor_rr'
  | 'motor_1'
  | 'motor_2'
  | 'motor_3'
  | 'motor_4'
  | 'motor_5'
  | 'motor_6'
  | 'wheel_fl'
  | 'wheel_fr'
  | 'wheel_rl'
  | 'wheel_rr'
  | `passenger_${number}`
  | 'wheel_left'
  | 'wheel_right'
  | 'caster_front'
  | 'caster_back'
  | 'imu'
  | 'battery'
  | 'controller'
  | 'sensor_front'
  | 'sensor_back'
  | 'sensor_left'
  | 'sensor_right'
  | 'passenger';

export type AssemblyChassisShape = 'horizontal_plate' | 'vertical_plate' | 'box' | 'frame' | 'custom_mesh';

export type AssemblyKinematicsModel =
  | 'differential_drive'
  | 'inverted_pendulum'
  | 'mecanum'
  | 'quadcopter'
  | 'hexacopter'
  | 'static';

/** One mount point, chassis-local millimetres. */
export interface AssemblyMount {
  role: AssemblyRole;
  at: AssemblyVec3;
  /** Local yaw in degrees applied to the mounted part. */
  rotY?: number;
}

export interface AssemblyChassis {
  shape: AssemblyChassisShape;
  size: AssemblyVec3;
  thickness?: number;
  color?: string;
  label?: string;
  mounts: AssemblyMount[];
  meshUrl?: string;
}

export interface AssemblyWheel {
  diameterMm: number;
  widthMm: number;
  side?: 'left' | 'right';
  color?: string;
  tireColor?: string;
}

export interface AssemblyKinematics {
  model: AssemblyKinematicsModel;
  wheelbaseMm?: number;
  trackMm?: number;
  deadbandRps?: number;
  gravity?: number;
  balancePointDeg?: number;
  maxTiltDeg?: number;
  liftK?: number;
  massKg?: number;
  closedLoopSensors?: boolean;
}

/**
 * The spec as persisted on the project. Identical in shape to Velxio's
 * `AssemblySpec`, except `bindings` reference Wireup *diagram* component ids
 * (stable across exports); the simulation bundle translates the controller to
 * the Velxio board id before pushing.
 */
export interface AssemblySpecJson {
  archetype?: string;
  chassis?: AssemblyChassis;
  wheel?: AssemblyWheel;
  kinematics: AssemblyKinematics;
  sensors?: { role: string; componentId?: string; at?: AssemblyVec3 }[];
  bindings?: Partial<Record<AssemblyRole, string>>;
  origin?: AssemblyVec3;
  rotYDeg?: number;
  meta?: Record<string, unknown>;
}

/** World-space placement of one instance, in bench millimetres. */
export interface AssemblyPlacement {
  x: number;
  y: number;
  z: number;
  /** Yaw in degrees (the `rotY` property the 3D scene reads). */
  rotY: number;
}

export type AssemblySource = 'model' | 'heuristic';

/**
 * The assembly as the simulation page consumes it: the pushed spec uses
 * Velxio ids (the controller is the board), and the counts describe what the
 * 3D scene will actually seat.
 */
export interface AssemblyBundleView {
  /** Velxio-id spec, ready to `postMessage` straight into LiveGround. */
  spec: AssemblySpecJson;
  archetype: string;
  label: string;
  source: AssemblySource;
  /** Seated instances (mounts + stacked + parametric) out of the roster. */
  placed: number;
  total: number;
  parametric: string[];
  /**
   * Mount roles the 3D scene draws parametrically — wheels, casters and
   * propellers have no electrical counterpart, so the spec renders them from
   * the archetype geometry wherever no real part claims the mount.
   */
  parametricRoles: string[];
  unplaced: string[];
  notes: string[];
  warnings: string[];
}

/**
 * The resolved, frozen assembly for a project revision.
 *
 * `placements` covers every instance the planner could seat: bound mounts
 * (world = chassis origin + mount), deck-stacked extras, and explicit
 * LLM placements for static builds. Anything left in `unplaced` renders in
 * the default bench grid; anything in `parametric` is drawn as part of the
 * chassis itself (propellers on a drone — the catalog carries no 3D body for
 * them, and the note says so).
 */
export interface ResolvedAssemblyPlan {
  version: 1;
  /** Base archetype id the spec was resolved from (`2wd_rover`, `static_bench`, …). */
  archetype: string;
  /** Human label, e.g. `RC car — 2WD rover`. */
  label: string;
  source: AssemblySource;
  spec: AssemblySpecJson;
  /** Role → diagram component id, pruned to instances that exist. */
  bindings: Partial<Record<AssemblyRole, string>>;
  /** Diagram component id → world placement. */
  placements: Record<string, AssemblyPlacement>;
  /** Diagram ids drawn parametrically as part of the vehicle (no own body). */
  parametric: string[];
  /**
   * Mount roles the scene renders parametrically (wheels, casters,
   * propellers — mechanical extras the electrical catalog cannot supply).
   * Roles, not instance ids, so pruning to surviving instances never
   * touches them. Optional: plans frozen before this field existed read as
   * "none recorded" and the scene still renders them from the spec.
   */
  parametricRoles?: string[];
  /** Diagram ids with no placement (bench grid). */
  unplaced: string[];
  notes: string[];
  warnings: string[];
  createdAt: string;
}
