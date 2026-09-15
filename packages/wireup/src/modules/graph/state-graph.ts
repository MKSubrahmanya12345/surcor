/**
 * Graph kernel — a LangGraph-style StateGraph for Wireup's agent loops.
 *
 * The shape is the published StateGraph contract, reduced to what Wireup
 * needs and written dependency-free so it runs anywhere (server, verifier,
 * edge):
 *
 *   - **State**: one shared object per run. Nodes return *partial updates*;
 *     the graph merges them through per-field **reducers** (`replace` for
 *     current values, `append` for accumulators like events/tasks — the
 *     "accumulator vs overwrite" rule from the LangGraph production notes).
 *   - **Nodes**: async functions `(state) => partial | { update, ... }`.
 *   - **Edges**: direct (`A → B`) or **conditional** (a function of state
 *     returning the next node name or `END`). Cycles are allowed — the pass
 *     loop IS a cycle — bounded by `maxSteps`.
 *   - **Checkpointing**: the full state is snapshotted after every node
 *     into a `Checkpointer` (in-memory by default; the pass persists the
 *     same deltas to the project doc). `getState` / `getHistory` /
 *     `updateState` give pause/resume/time-travel per `threadId`.
 *   - **Interrupts**: `interruptBefore: ['persist']` compiles a pause point
 *     — `invoke` returns `{ interrupted: true }` with the state saved, and
 *     a later `invoke(null)` resumes exactly there (LangGraph's
 *     human-in-the-loop, minus the Python).
 *
 * What this is NOT: a LangGraph port. No prebuilt agents, no postgres
 * saver, no streaming protocol. The point is one explicit, typed,
 * checkpointed execution shape for the continuation pass — see
 * `src/modules/everflow/pass-graph.ts` for the production graph.
 */

export const START = '__start__';
export const END = '__end__';

export type ReducerKind = 'replace' | 'append';

export type ReducerMap<S extends Record<string, unknown>> = {
  [K in keyof S]?: ReducerKind;
};

export type NodeUpdate<S extends Record<string, unknown>> = Partial<S>;

export type GraphNodeFn<S extends Record<string, unknown>> = (state: S) => Promise<NodeUpdate<S>> | NodeUpdate<S>;

export type ConditionalFn<S extends Record<string, unknown>> = (state: S) => string | typeof END;

export interface Checkpoint<S extends Record<string, unknown>> {
  threadId: string;
  step: number;
  node: string;
  state: S;
  at: string;
}

export interface Checkpointer<S extends Record<string, unknown>> {
  save(checkpoint: Checkpoint<S>): Promise<void>;
  latest(threadId: string): Promise<Checkpoint<S> | null>;
  history(threadId: string): Promise<Checkpoint<S>[]>;
}

/** In-process checkpointer (dev + verifier + single-server runs). */
export class MemoryCheckpointer<S extends Record<string, unknown>> implements Checkpointer<S> {
  private readonly runs = new Map<string, Checkpoint<S>[]>();

  async save(checkpoint: Checkpoint<S>): Promise<void> {
    const list = this.runs.get(checkpoint.threadId) ?? [];
    list.push(structuredCloneShallow(checkpoint));
    this.runs.set(checkpoint.threadId, list);
  }

  async latest(threadId: string): Promise<Checkpoint<S> | null> {
    const list = this.runs.get(threadId) ?? [];
    return list.length > 0 ? list[list.length - 1] : null;
  }

  async history(threadId: string): Promise<Checkpoint<S>[]> {
    return [...(this.runs.get(threadId) ?? [])];
  }
}

function structuredCloneShallow<S extends Record<string, unknown>>(checkpoint: Checkpoint<S>): Checkpoint<S> {
  // structuredClone exists on Node ≥ 17; fall back to JSON for exotic hosts.
  try {
    return { ...checkpoint, state: structuredClone(checkpoint.state) as S };
  } catch {
    return { ...checkpoint, state: JSON.parse(JSON.stringify(checkpoint.state)) as S };
  }
}

export interface CompiledGraphOptions {
  maxSteps?: number;
  /** Node names that pause the run BEFORE executing (persisted interrupt). */
  interruptBefore?: string[];
  /** Called after every node (checkpoint metadata, steer folding, logging). */
  onStep?: (info: { threadId: string; step: number; node: string; next: string }) => void | Promise<void>;
}

export interface InvokeResult<S extends Record<string, unknown>> {
  state: S;
  steps: number;
  /** Set when the run paused at an `interruptBefore` node. */
  interrupted: string | null;
  /** Set when `maxSteps` stopped a cyclic run (reported, never silent). */
  stepLimitHit: boolean;
  path: string[];
}

function mergeUpdate<S extends Record<string, unknown>>(state: S, update: NodeUpdate<S>, reducers: ReducerMap<S>): S {
  const next = { ...state };
  for (const [key, value] of Object.entries(update)) {
    const field = key as keyof S;
    if (value === undefined) continue;
    if (reducers[field] === 'append') {
      const current = next[field];
      if (Array.isArray(current) && Array.isArray(value)) next[field] = [...current, ...(value as unknown[])] as S[keyof S];
      else if (Array.isArray(current)) next[field] = [...current, value] as unknown as S[keyof S];
      else next[field] = value as S[keyof S];
    } else {
      next[field] = value as S[keyof S];
    }
  }
  return next;
}

export class StateGraph<S extends Record<string, unknown>> {
  private readonly nodes = new Map<string, GraphNodeFn<S>>();
  private readonly direct = new Map<string, string>();
  private readonly conditional = new Map<string, ConditionalFn<S>>();
  private readonly reducers: ReducerMap<S>;
  private entry = '';

  constructor(reducers: ReducerMap<S> = {}) {
    this.reducers = reducers;
  }

  addNode(name: string, fn: GraphNodeFn<S>): this {
    if (name === START || name === END) throw new Error(`"${name}" is reserved.`);
    if (this.nodes.has(name)) throw new Error(`Duplicate node "${name}".`);
    this.nodes.set(name, fn);
    return this;
  }

  setEntryPoint(name: string): this {
    this.entry = name;
    return this;
  }

  addEdge(from: string, to: string): this {
    this.direct.set(from, to);
    return this;
  }

  addConditionalEdges(from: string, fn: ConditionalFn<S>): this {
    this.conditional.set(from, fn);
    return this;
  }

  compile(checkpointer: Checkpointer<S> = new MemoryCheckpointer<S>()): CompiledGraph<S> {
    if (!this.entry) throw new Error('No entry point: call setEntryPoint().');
    if (!this.nodes.has(this.entry)) throw new Error(`Entry point "${this.entry}" is not a node.`);
    return new CompiledGraph<S>({
      nodes: this.nodes,
      direct: this.direct,
      conditional: this.conditional,
      reducers: this.reducers,
      entry: this.entry,
      checkpointer,
    });
  }
}

interface CompiledParts<S extends Record<string, unknown>> {
  nodes: Map<string, GraphNodeFn<S>>;
  direct: Map<string, string>;
  conditional: Map<string, ConditionalFn<S>>;
  reducers: ReducerMap<S>;
  entry: string;
  checkpointer: Checkpointer<S>;
}

export class CompiledGraph<S extends Record<string, unknown>> {
  private readonly parts: CompiledParts<S>;

  constructor(parts: CompiledParts<S>) {
    this.parts = parts;
  }

  get checkpointer(): Checkpointer<S> {
    return this.parts.checkpointer;
  }

  /** Current persisted state for a thread (null when the thread never ran). */
  async getState(threadId: string): Promise<S | null> {
    const latest = await this.parts.checkpointer.latest(threadId);
    return latest ? latest.state : null;
  }

  async getHistory(threadId: string): Promise<Checkpoint<S>[]> {
    return this.parts.checkpointer.history(threadId);
  }

  /**
   * Merge an external update into the thread's latest state (LangGraph's
   * `update_state`) — how a human answer re-enters a paused run.
   */
  async updateState(threadId: string, update: NodeUpdate<S>): Promise<S | null> {
    const latest = await this.parts.checkpointer.latest(threadId);
    if (!latest) return null;
    const merged = mergeUpdate(latest.state, update, this.parts.reducers);
    await this.parts.checkpointer.save({ threadId, step: latest.step + 1, node: latest.node, state: merged, at: new Date().toISOString() });
    return merged;
  }

  private route(from: string, state: S): string {
    const conditional = this.parts.conditional.get(from);
    if (conditional) return conditional(state);
    return this.parts.direct.get(from) ?? END;
  }

  /**
   * Run the graph. `input` seeds a fresh thread; pass `null` with a
   * `threadId` that was interrupted to resume from its checkpoint.
   */
  async invoke(threadId: string, input: S | null, options: CompiledGraphOptions = {}): Promise<InvokeResult<S>> {
    const maxSteps = options.maxSteps ?? 25;
    const interrupts = new Set(options.interruptBefore ?? []);
    const path: string[] = [];
    let steps = 0;

    let state: S;
    let next: string;
    if (input === null) {
      const resumed = await this.parts.checkpointer.latest(threadId);
      if (!resumed) throw new Error(`Thread "${threadId}" has no checkpoint to resume from.`);
      state = resumed.state;
      // Resume AT the interrupted node (the checkpoint names it).
      next = resumed.node;
      // If the checkpoint is a finished run, there is nothing to resume.
      if (next === END) return { state, steps: 0, interrupted: null, stepLimitHit: false, path: [] };
    } else {
      state = input;
      next = this.route(START, state) === END ? this.parts.entry : this.route(START, state);
      // `START → entry` when no explicit START edge was added.
      if (!this.parts.direct.has(START) && !this.parts.conditional.has(START)) next = this.parts.entry;
    }

    while (next !== END) {
      if (interrupts.has(next)) {
        await this.parts.checkpointer.save({ threadId, step: steps, node: next, state, at: new Date().toISOString() });
        return { state, steps, interrupted: next, stepLimitHit: false, path };
      }
      const fn = this.parts.nodes.get(next);
      if (!fn) throw new Error(`Node "${next}" is routed to but not defined.`);
      path.push(next);
      const update = await fn(state);
      state = mergeUpdate(state, update, this.parts.reducers);
      steps += 1;
      await this.parts.checkpointer.save({ threadId, step: steps, node: next, state, at: new Date().toISOString() });
      const following = this.route(next, state);
      await options.onStep?.({ threadId, step: steps, node: next, next: following });
      next = following;
      if (steps >= maxSteps && next !== END) {
        await this.parts.checkpointer.save({ threadId, step: steps, node: END, state, at: new Date().toISOString() });
        return { state, steps, interrupted: null, stepLimitHit: true, path };
      }
    }
    await this.parts.checkpointer.save({ threadId, step: steps, node: END, state, at: new Date().toISOString() });
    return { state, steps, interrupted: null, stepLimitHit: false, path };
  }
}
