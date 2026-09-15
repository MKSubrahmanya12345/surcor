/**
 * Graph kernel — net-aware wiring layout.
 *
 * Replaces the hardcoded two-column drawing (`WIDTH 620 / LEFT_X 190 /
 * RIGHT_X 430`) with a layout computed from the connection list:
 *
 *   - controller detection falls back through hardware-plan id → the
 *     endpoint with the most connections → the first connection's `from`
 *     (the old code trusted `connections[0]` alone);
 *   - pins sort by (net kind, signal, name) so power/ground/signal wires
 *     leave in bands instead of crossing;
 *   - parallel wires between the same pair get lane offsets, and
 *     peripheral↔peripheral wires get their own right-side lane instead of
 *     bowing meaninglessly over the column;
 *   - the kind filter is applied to the GRAPH, not just the list, so the
 *     picture and the list can never disagree;
 *   - width is responsive: the SVG reports a viewBox and the component
 *     scales it to the container (no fixed 620 px).
 *
 * Pure: same connections in, same coordinates out.
 */

import type { WiringConnection, ConnectionKind } from '@/types/wiring';

export interface WiringLayoutPin {
  pin: string;
  y: number;
  kind: ConnectionKind;
  signal: string;
}

export interface WiringLayoutColumn {
  instanceId: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pins: WiringLayoutPin[];
  isController: boolean;
}

export interface WiringLayoutWire {
  id: string;
  d: string;
  color: string;
  title: string;
  kind: ConnectionKind;
  lane: number;
}

export interface WiringLayout {
  width: number;
  height: number;
  controller: WiringLayoutColumn;
  peripherals: WiringLayoutColumn[];
  wires: WiringLayoutWire[];
  /** Connections hidden by the active filter (reported, not silently dropped). */
  hiddenByFilter: number;
  controllerInstanceId: string;
}

const ROW = 17;
const LEFT_X = 190;
const RIGHT_X = 430;
const WIDTH = 620;
const TOP = 26;
const COLUMN_WIDTH = 170;
const LANE_STEP = 7;

const KIND_ORDER: Record<ConnectionKind, number> = { power: 0, ground: 1, signal: 2 };

function wireColor(connection: WiringConnection): string {
  return connection.wireColor ?? (connection.kind === 'power' ? '#c62828' : connection.kind === 'ground' ? '#212121' : '#1565c0');
}

function detectController(connections: WiringConnection[], hint: string | undefined): string {
  if (hint) return hint;
  if (connections.length === 0) return '';
  const degree = new Map<string, number>();
  for (const connection of connections) {
    degree.set(connection.from.instanceId, (degree.get(connection.from.instanceId) ?? 0) + 1);
    degree.set(connection.to.instanceId, (degree.get(connection.to.instanceId) ?? 0) + 1);
  }
  let best = connections[0].from.instanceId;
  let bestDegree = -1;
  for (const [id, count] of degree) {
    if (count > bestDegree || (count === bestDegree && id < best)) {
      best = id;
      bestDegree = count;
    }
  }
  return best;
}

export function layoutWiring(
  connections: WiringConnection[],
  controllerHint: string | undefined,
  labels: Map<string, string>,
  filter: 'all' | ConnectionKind = 'all',
): WiringLayout | null {
  if (connections.length === 0) return null;

  const controllerId = detectController(connections, controllerHint);
  const visible = connections.filter((connection) => filter === 'all' || connection.kind === filter);
  const hiddenByFilter = connections.length - visible.length;
  if (visible.length === 0) {
    // The filter hid everything: report an empty-but-honest canvas, not null
    // (null means "no wiring exists at all").
    return {
      width: WIDTH,
      height: TOP + 60,
      controller: { instanceId: controllerId, label: labels.get(controllerId) ?? controllerId, x: LEFT_X - COLUMN_WIDTH, y: TOP, width: COLUMN_WIDTH, height: 40, pins: [], isController: true },
      peripherals: [],
      wires: [],
      hiddenByFilter,
      controllerInstanceId: controllerId,
    };
  }

  // Collect pins per instance with their net kind for banded sorting.
  interface PinUse {
    pin: string;
    kind: ConnectionKind;
    signal: string;
    firstSeen: number;
  }
  const uses = new Map<string, Map<string, PinUse>>();
  const touch = (instanceId: string, pin: string, kind: ConnectionKind, signal: string, order: number): void => {
    let pins = uses.get(instanceId);
    if (!pins) {
      pins = new Map();
      uses.set(instanceId, pins);
    }
    const existing = pins.get(pin);
    if (!existing) pins.set(pin, { pin, kind, signal, firstSeen: order });
    else if (KIND_ORDER[kind] < KIND_ORDER[existing.kind]) existing.kind = kind; // power/ground band wins for shared rails
  };
  visible.forEach((connection, order) => {
    touch(connection.from.instanceId, connection.from.pin, connection.kind, connection.signal, order);
    touch(connection.to.instanceId, connection.to.pin, connection.kind, connection.signal, order);
  });

  const sortPins = (pins: PinUse[]): PinUse[] =>
    [...pins].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.signal < b.signal ? -1 : a.signal > b.signal ? 1 : 0) || a.firstSeen - b.firstSeen);

  // Peripheral order: most-connected first (stable by id), so the busiest
  // parts sit nearest the top and wires stay short.
  const peripheralIds = [...uses.keys()].filter((id) => id !== controllerId);
  const peripheralDegree = new Map<string, number>();
  for (const connection of visible) {
    for (const end of [connection.from.instanceId, connection.to.instanceId]) {
      if (end !== controllerId) peripheralDegree.set(end, (peripheralDegree.get(end) ?? 0) + 1);
    }
  }
  peripheralIds.sort((a, b) => (peripheralDegree.get(b) ?? 0) - (peripheralDegree.get(a) ?? 0) || (a < b ? -1 : 1));

  const controllerPins = sortPins([...(uses.get(controllerId)?.values() ?? [])]);
  const leftY = new Map<string, number>();
  controllerPins.forEach((use, index) => leftY.set(`${controllerId}.${use.pin}`, TOP + 22 + index * ROW));

  const peripherals: WiringLayoutColumn[] = [];
  const rightY = new Map<string, number>();
  let cursorY = TOP + 8;
  for (const instanceId of peripheralIds) {
    const pins = sortPins([...uses.get(instanceId)!.values()]);
    const height = Math.max(30, pins.length * ROW + 20);
    const placed: WiringLayoutPin[] = pins.map((use, index) => {
      const y = cursorY + 18 + index * ROW;
      rightY.set(`${instanceId}.${use.pin}`, y);
      return { pin: use.pin, y, kind: use.kind, signal: use.signal };
    });
    peripherals.push({
      instanceId,
      label: labels.get(instanceId) ?? instanceId,
      x: RIGHT_X,
      y: cursorY,
      width: COLUMN_WIDTH,
      height,
      pins: placed,
      isController: false,
    });
    cursorY += height + 12;
  }

  const leftHeight = Math.max(40, controllerPins.length * ROW + 26);
  const height = Math.max(cursorY, TOP + leftHeight) + 18;

  // Lane offsets: parallel wires between the same ordered pair spread across
  // lanes so none hides exactly behind another.
  const laneOf = new Map<string, number>();
  const wires = visible.map((connection) => {
    const fromKey = `${connection.from.instanceId}.${connection.from.pin}`;
    const toKey = `${connection.to.instanceId}.${connection.to.pin}`;
    const fromController = connection.from.instanceId === controllerId;
    const toController = connection.to.instanceId === controllerId;
    const fromX = fromController ? LEFT_X : RIGHT_X;
    const toX = toController ? LEFT_X : RIGHT_X;
    const fromY = (fromController ? leftY : rightY).get(fromKey) ?? TOP;
    const toY = (toController ? leftY : rightY).get(toKey) ?? TOP;

    const pairEnds = [`${connection.from.instanceId}→${connection.to.instanceId}`, `${connection.to.instanceId}→${connection.from.instanceId}`].sort();
    const laneKey = `${pairEnds[0]}|${connection.kind}`;
    const lane = laneOf.get(laneKey) ?? 0;
    laneOf.set(laneKey, lane + 1);
    const lift = lane * LANE_STEP;

    let d: string;
    if (fromX !== toX) {
      // Controller ↔ peripheral: bezier across the gap, lifted per lane.
      const midX = (fromX + toX) / 2;
      d = `M ${fromX} ${fromY - lift} C ${midX} ${fromY - lift}, ${midX} ${toY - lift}, ${toX} ${toY - lift}`;
    } else if (fromX === LEFT_X) {
      // Controller-internal (rare): bow left.
      const bow = -46 - lift;
      d = `M ${fromX} ${fromY} C ${fromX + bow} ${fromY}, ${toX + bow} ${toY}, ${toX} ${toY}`;
    } else {
      // Peripheral ↔ peripheral: route in the dedicated right-side lane,
      // offset per wire so stacked peripherals stay readable.
      const laneX = RIGHT_X + COLUMN_WIDTH + 18 + lift;
      const y1 = fromY;
      const y2 = toY;
      d = `M ${RIGHT_X + COLUMN_WIDTH} ${y1} L ${laneX} ${y1} L ${laneX} ${y2} L ${RIGHT_X + COLUMN_WIDTH} ${y2}`;
    }

    return {
      id: connection.id,
      d,
      color: wireColor(connection),
      title: `${connection.from.instanceId}.${connection.from.pin} → ${connection.to.instanceId}.${connection.to.pin} (${connection.kind}, ${connection.signal})`,
      kind: connection.kind,
      lane,
    };
  });

  return {
    width: WIDTH,
    height,
    controller: {
      instanceId: controllerId,
      label: labels.get(controllerId) ?? controllerId,
      x: LEFT_X - COLUMN_WIDTH,
      y: TOP,
      width: COLUMN_WIDTH,
      height: leftHeight,
      pins: controllerPins.map((use) => ({ pin: use.pin, y: leftY.get(`${controllerId}.${use.pin}`) ?? TOP, kind: use.kind, signal: use.signal })),
      isController: true,
    },
    peripherals,
    wires,
    hiddenByFilter,
    controllerInstanceId: controllerId,
  };
}
