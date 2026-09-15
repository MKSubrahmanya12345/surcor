/**
 * Wiring / connectivity types.
 *
 * The wiring plan is an explicit directed connection graph: every edge names a
 * source component instance + pin and a destination component instance + pin.
 */

export type ConnectionKind = 'power' | 'ground' | 'signal';

export type SignalType =
  | 'digital'
  | 'analog'
  | 'pwm'
  | 'uart'
  | 'i2c'
  | 'spi'
  | 'one_wire'
  | 'motor_drive'
  | 'enable'
  | 'interrupt'
  | 'power'
  | 'ground'
  | 'unknown';

export type ConnectionProtocol = 'gpio' | 'uart' | 'i2c' | 'spi' | 'adc' | 'pwm' | 'one_wire' | 'power' | 'other';

/** One endpoint of a connection. */
export interface WiringEndpoint {
  /** Catalog component id, e.g. `l298n-motor-driver`. */
  componentId: string;
  /** Concrete instance id, e.g. `l298n-motor-driver-1`. */
  instanceId: string;
  /** Pin name on that component, e.g. `IN1`, `GND`, `GPIO25`. */
  pin: string;
  /** Optional human friendly pin label. */
  pinLabel?: string;
}

export interface WiringConnection {
  id: string;
  from: WiringEndpoint;
  to: WiringEndpoint;
  kind: ConnectionKind;
  signal: SignalType;
  protocol: ConnectionProtocol;
  direction: 'unidirectional' | 'bidirectional';
  /** Rail voltage when this is a power/ground edge. */
  voltage?: number;
  /** Why this wire exists. Shown to the user in the wiring view. */
  explanation: string;
  /** Which module produced this edge. */
  source: 'planner' | 'model' | 'fixer';
  /** Suggested wire colour for the diagram (hex or name). */
  wireColor?: string;
  metadata?: Record<string, unknown>;
}

export type WiringConflictCode =
  | 'gpio_conflict'
  | 'motor_on_mcu_pin'
  | 'missing_ground'
  | 'missing_power'
  | 'invalid_voltage'
  | 'output_to_output'
  | 'input_only_pin_driven'
  | 'reserved_pin_used'
  | 'unknown_pin'
  | 'incompatible_components'
  | 'duplicate_connection'
  | 'floating_required_pin'
  | 'dangling_reference'
  | 'capability_mismatch'
  | 'power_budget_exceeded';

export interface WiringConflict {
  id: string;
  code: WiringConflictCode;
  severity: 'error' | 'warning';
  message: string;
  /** Instance ids involved. */
  instanceIds: string[];
  /** Pin names involved. */
  pins: string[];
  connectionIds: string[];
  suggestion?: string;
}

export interface WiringPlan {
  connections: WiringConnection[];
  conflicts: WiringConflict[];
  /** Distinct electrical nets, e.g. the 5V rail or a common ground net. */
  nets: WiringNet[];
  notes: string[];
  generatedAt: string;
}

export interface WiringNet {
  id: string;
  name: string;
  kind: ConnectionKind;
  signal: SignalType;
  voltage?: number;
  members: { instanceId: string; pin: string }[];
}

/** A resolved MCU pin assignment (output of the pin planner). */
export interface PinAssignment {
  id: string;
  /** The microcontroller instance that owns the pin. */
  mcuInstanceId: string;
  mcuComponentId: string;
  /** Canonical pin name on the MCU, e.g. `GPIO25` or `D5`. */
  pin: string;
  pinNumber?: number;
  /** The peripheral instance + pin being driven. */
  targetInstanceId: string;
  targetComponentId: string;
  targetPin: string;
  purpose: string;
  signal: SignalType;
  direction: 'input' | 'output';
  protocol: ConnectionProtocol;
  required: boolean;
  /** Why this specific pin was chosen (capability, reservation, conflict avoidance). */
  rationale: string;
  source: 'planner' | 'model' | 'fixer';
}
