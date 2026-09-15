/**
 * Canonical hardware component types.
 *
 * These types are pure (no runtime code) so they can be imported safely from
 * both server and client components.
 */

/** High level classification used for planning, layout and retrieval. */
export type ComponentCategory =
  | 'microcontroller'
  | 'motor'
  | 'motor_driver'
  | 'sensor'
  | 'communication'
  | 'actuator'
  | 'display'
  | 'power'
  | 'passive'
  | 'discrete'
  | 'electromechanical'
  | 'input_device'
  | 'prototyping'
  | 'other';

/** Electrical / logical nature of a pin. */
export type ComponentPinType =
  | 'digital'
  | 'analog'
  | 'pwm'
  | 'uart'
  | 'i2c'
  | 'spi'
  | 'one_wire'
  | 'power'
  | 'ground'
  | 'motor'
  | 'enable'
  | 'control'
  | 'signal'
  | 'other';

export type PinDirection = 'input' | 'output' | 'bidirectional' | 'power' | 'ground';

/** A single physical/logical pin exposed by a component. */
export interface ComponentPin {
  /** Silkscreen / datasheet name, e.g. `GPIO25`, `IN1`, `OUT2`, `VCC`, `GND`. */
  name: string;
  type: ComponentPinType;
  direction: PinDirection;
  /** Must this pin be connected for the component to function? */
  required: boolean;
  /** Human readable signal description, e.g. "Motor A direction (IN1)". */
  signal?: string;
  description?: string;
  /** Alternative names accepted when matching model output to the catalog. */
  aliases?: string[];
  /** Operating/logic voltage of this pin when known. */
  voltage?: number;
  /** Acceptable supply window for a power pin (e.g. a 3–5.5 V regulated input). */
  minVoltage?: number;
  maxVoltage?: number;
  /** For pins that must be tied to a specific MCU capability. */
  requiresCapability?: string[];
}

export interface CurrentRequirements {
  typicalMa?: number;
  maxMa?: number;
  note?: string;
}

export interface LibraryRequirement {
  /** Library manager name, e.g. "DHT sensor library". */
  name: string;
  /** Header/module imported by the firmware, e.g. "DHT.h". */
  import: string;
  manager?: 'arduino' | 'esp-idf' | 'platformio' | 'pip' | 'other';
  version?: string;
  repository?: string;
  purpose: string;
  /** True when the capability ships with the platform (no install needed). */
  builtIn?: boolean;
}

/** Motor-specific engineering data. Only populated where actually known. */
export interface MotorRequirements {
  motorType?: 'dc' | 'servo' | 'stepper';
  channels?: number;
  requiresDriver?: boolean;
  requiresExternalSupply?: boolean;
  supplyVoltageMin?: number;
  supplyVoltageMax?: number;
  maxCurrentPerChannelMa?: number;
  stallCurrentMa?: number;
  holdingTorqueKgCm?: number;
  stepsPerRevolution?: number;
  rpm?: number;
  controlSignal?: 'pwm' | 'digital' | 'analog' | 'serial' | 'step_dir';
  logicVoltage?: number;
}

/** Power-source specific data (batteries, regulators, supplies). */
export interface PowerSourceRequirements {
  outputVoltage?: number;
  outputVoltageMin?: number;
  outputVoltageMax?: number;
  capacityMah?: number;
  maxCurrentMa?: number;
  adjustable?: boolean;
  chemistry?: string;
  rail?: string;
}

export interface SimulatorMapping {
  /** Simulator part identifier, e.g. `wokwi-l298n`. */
  part?: string;
  attrs?: Record<string, string>;
  supported?: boolean;
  notes?: string;
}

/**
 * A catalog entry. The LLM is only allowed to pick from this database —
 * anything it invents is re-mapped onto the nearest catalog entry by the
 * hardware planner.
 */
export interface ComponentDefinition {
  id: string;
  name: string;
  category: ComponentCategory;
  description: string;
  /** Nominal operating voltage (V). Omitted when unknown/variable. */
  voltage?: number;
  minVoltage?: number;
  maxVoltage?: number;
  currentRequirements?: CurrentRequirements;
  pins: ComponentPin[];
  /** Distinct electrical pin types this component exposes. */
  pinTypes: ComponentPinType[];
  communicationProtocols: string[];
  powerPins: string[];
  groundPins: string[];
  /** Component ids / families this part is known to work with. */
  compatibleMicrocontrollers?: string[];
  incompatibleComponents?: string[];
  motorRequirements?: MotorRequirements;
  powerSourceRequirements?: PowerSourceRequirements;
  libraryRequirements?: LibraryRequirement[];
  exampleUsage?: string[];
  /** Alternate names used for fuzzy matching against model output. */
  aliases?: string[];
  keywords?: string[];
  simulator?: SimulatorMapping;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/** A concrete, addressable copy of a component inside a project. */
export interface ComponentInstance {
  instanceId: string;
  componentId: string;
  name: string;
  /** 1-based index within its selection (motor 1 of 2 …). */
  index: number;
  /** Functional label, e.g. "Left motor". */
  label?: string;
  category: ComponentCategory;
}

export type ComponentRole =
  | 'controller'
  | 'driver'
  | 'sensor'
  | 'actuator'
  | 'communication'
  | 'power'
  | 'input'
  | 'display'
  | 'passive'
  | 'prototyping'
  | 'other';

export interface ComponentSelection {
  id: string;
  componentId: string;
  name: string;
  category: ComponentCategory;
  role: ComponentRole;
  quantity: number;
  /** Why this part is in the build — always required, never empty. */
  reason: string;
  required: boolean;
  instances: ComponentInstance[];
  /** `catalog` = matched to the database, `model` = invented by the LLM, `planner` = added by the planner. */
  source: 'catalog' | 'model' | 'planner';
  /** What the model asked for before catalog matching, when it differed. */
  matchedFrom?: string;
  notes?: string;
}

export interface PowerRail {
  rail: string;
  voltage: number;
  typicalMa?: number;
  peakMa?: number;
  loads: string[];
  sourceInstanceId?: string;
}

export interface PowerBudget {
  /** Primary supply voltage feeding the system. */
  supplyVoltage?: number;
  supplyInstanceId?: string;
  supplyComponentId?: string;
  totalTypicalMa?: number;
  totalPeakMa?: number;
  /**
   * The sustained load the supply must carry continuously (motors at stall
   * count; radio bursts do not). Exposed so a repair can size a replacement
   * supply without re-deriving the load model.
   */
  sustainedPeakMa?: number;
  rails: PowerRail[];
  regulator?: {
    componentId?: string;
    instanceId?: string;
    inputVoltage?: number;
    outputVoltage?: number;
  };
  adequate: boolean;
  /** The specific reasons `adequate` is false (empty when the budget is fine). */
  shortfalls?: string[];
  notes: string[];
}
