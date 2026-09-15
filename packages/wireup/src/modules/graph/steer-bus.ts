/**
 * Graph kernel — the steer bus (Astra-style mid-turn steering, Tier-1.5).
 *
 * GPT-6 Astra's mid-turn steering inserts new instructions while the model
 * is working, preserving completed work. Wireup's Next.js route layer cannot
 * hold the Responses WebSocket that makes that mid-*token*, so the bus is
 * the honest middle: steers published during a pass are drained at every
 * StateGraph node boundary *inside* the running pass and folded into the
 * plan — mid-pass at the next tool boundary, not "next pass or nothing".
 *
 * The interface is the seam a future WebSocket transport would plug into:
 * `publishSteer` from the socket handler, `drainSteers` already called at
 * the boundaries. Until then the events label deliveries exactly:
 * "folded at the <node> boundary" (Tier-1.5) vs "read on the next pass"
 * (Tier-1). Nothing advertises Tier-2.
 */

export interface SteerMessage {
  id: string;
  projectId: string;
  text: string;
  title: string;
  at: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __wireupSteerBus: Map<string, SteerMessage[]> | undefined;
}

function bus(): Map<string, SteerMessage[]> {
  if (!globalThis.__wireupSteerBus) globalThis.__wireupSteerBus = new Map();
  return globalThis.__wireupSteerBus;
}

/** Publish a steer for a project (the inject route calls this for `steer`). */
export function publishSteer(message: SteerMessage): void {
  const list = bus().get(message.projectId) ?? [];
  list.push(message);
  bus().set(message.projectId, list);
}

/** How many steers are waiting for a project (without consuming them). */
export function pendingSteers(projectId: string): number {
  return bus().get(projectId)?.length ?? 0;
}

/**
 * Drain (consume) all waiting steers for a project. The pass graph calls
 * this after every node — the "tool boundary" where steering folds in.
 */
export function drainSteers(projectId: string): SteerMessage[] {
  const list = bus().get(projectId) ?? [];
  bus().set(projectId, []);
  return list;
}

/** Test seam: clear every queue. */
export function clearSteerBus(): void {
  bus().clear();
}
