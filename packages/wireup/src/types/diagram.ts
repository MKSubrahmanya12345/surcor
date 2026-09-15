/**
 * `diagram.json` schema.
 *
 * The diagram is a self-contained, machine readable description of the build:
 * component instances with layout coordinates, their pins, and the wires
 * between them. It is deliberately simulator-agnostic — `modules/diagram-generator/wokwi.ts`
 * projects this structure into the Wokwi `diagram.json` shape without touching
 * the planner that produced it.
 */

import type { ComponentCategory } from './component';
import type { ConnectionKind, SignalType } from './wiring';

export interface DiagramPin {
  /** Pin name as it appears on the part, e.g. `GPIO25`, `IN1`. */
  name: string;
  /** Optional display label. */
  label?: string;
  type?: string;
  direction?: 'input' | 'output' | 'bidirectional' | 'power' | 'ground';
  /** MCU pin name this peripheral pin is bound to (populated on non-MCU parts). */
  assignedTo?: string;
  /** Absolute anchor point used by the renderer/simulator. */
  x?: number;
  y?: number;
  connected?: boolean;
}

export interface DiagramComponent {
  /** Unique instance id within the diagram, e.g. `motor-dc-2`. */
  id: string;
  /** Catalog component definition id. */
  ref: string;
  /** Normalised type token, e.g. `board.esp32`, `chip.l298n`, `motor.dc`. */
  type: string;
  name: string;
  label?: string;
  category: ComponentCategory;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: 0 | 90 | 180 | 270;
  pins: DiagramPin[];
  /** Simulator adapter hints (filled from the catalog `simulator` mapping). */
  simulator?: {
    part?: string;
    attrs?: Record<string, string>;
    supported?: boolean;
    notes?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface DiagramConnection {
  id: string;
  from: { component: string; pin: string };
  to: { component: string; pin: string };
  kind: ConnectionKind;
  signal: SignalType;
  label?: string;
  wireColor?: string;
  voltage?: number;
  /** Optional orthogonal routing hints consumed by a renderer. */
  path?: { x: number; y: number }[];
}

export interface DiagramRail {
  id: string;
  name: string;
  kind: 'power' | 'ground';
  voltage?: number;
  members: { component: string; pin: string }[];
}

export interface DiagramGroup {
  id: string;
  name: string;
  description?: string;
  memberIds: string[];
}

export interface Diagram {
  /** Bumped whenever the wireup diagram schema changes. */
  version: '1.0';
  format: 'wireup-diagram';
  generator: string;
  createdAt: string;
  projectId: string;
  revision: number;
  meta: {
    title: string;
    description: string;
    platform?: string;
    controllerInstanceId?: string;
    /** Where this diagram is intended to be consumed. */
    simulatorTarget: 'generic' | 'wokwi';
    units: 'px';
    gridSize: number;
  };
  components: DiagramComponent[];
  connections: DiagramConnection[];
  rails: DiagramRail[];
  groups: DiagramGroup[];
  layout: {
    width: number;
    height: number;
    columns: number;
    rows: number;
  };
  /** Free-form statistics that the UI can display without recomputation. */
  stats: {
    components: number;
    connections: number;
    powerConnections: number;
    groundConnections: number;
    signalConnections: number;
    pins: number;
  };
}
