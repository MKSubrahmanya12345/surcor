/**
 * Terminal sessions — the server half of the dock.
 *
 * One session = one folder + an ordered list of commands, run one after the
 * other in a child process whose output is buffered and pushed to every
 * subscriber. The default sequence is the one the user asked for:
 *
 *   npm install   (or pnpm/yarn/bun, from the folder's lockfile)
 *   npm run dev   (or whatever `scripts.dev`/`scripts.start` the folder has)
 *
 * ── Why this is not a WebSocket ─────────────────────────────────────────────
 * Output only flows one way, and the thing producing it outlives any single
 * HTTP request. SSE over a route handler gives exactly that with no extra
 * dependency: the browser reconnects, gets a snapshot, and carries on. Stdin is
 * a plain POST, because interactive prompts are rare and a request body is the
 * simplest honest channel for them.
 *
 * ── Why the child is detached ───────────────────────────────────────────────
 * `npm run dev` forks Vite. Killing only npm leaves the dev server running on
 * the port with nothing attached to it, which is the worst possible outcome of
 * a "stop" button. The child therefore gets its own process group and stopping
 * a session signals the group.
 *
 * Sessions live on `globalThis` so a dev-mode recompile of this module does not
 * orphan the processes it started.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { logger } from '@/lib/logging/logger';
import { nowIso } from '@/lib/validation/time';

import { devCommandFor, installCommandFor, terminalPolicy, validateCommand, type TerminalPolicy } from './guard';
import type {
  LineStream,
  StepState,
  TerminalLine,
  TerminalSessionSnapshot,
  TerminalSessionState,
  TerminalStep,
  TerminalStreamEvent,
} from './types';

/* eslint-disable @typescript-eslint/no-explicit-any -- globalThis stash for dev reloads */
interface GlobalStash {
  __wireupTerminal?: Map<string, Session>;
  __wireupTerminalHooked?: boolean;
}
const stash = globalThis as unknown as GlobalStash;

const ANSI = /\u001b\[[0-9;?]*[a-zA-Z]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[=>]/g;
const LOCAL_URL = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[[0-9a-fA-F:]+\])(?::\d+)?[^\s"'<>)\]]*)/;

function registry(): Map<string, Session> {
  if (!stash.__wireupTerminal) stash.__wireupTerminal = new Map();
  return stash.__wireupTerminal;
}

/* -------------------------------------------------------------------------- */
/* Session                                                                    */
/* -------------------------------------------------------------------------- */

export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly projectId: string | null;
  readonly createdAt = nowIso();

  private readonly policy: TerminalPolicy;
  private readonly steps: TerminalStep[];
  private readonly lines: TerminalLine[] = [];
  private readonly listeners = new Set<(event: TerminalStreamEvent) => void>();

  private seq = 0;
  private total = 0;
  private dropped = 0;
  private index = 0;
  private child: ChildProcess | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private state: TerminalSessionState = 'running';
  private url: string | null = null;
  private updatedAt = nowIso();
  private finished = false;

  constructor(input: { id: string; cwd: string; projectId: string | null; steps: TerminalStep[]; policy: TerminalPolicy }) {
    this.id = input.id;
    this.cwd = input.cwd;
    this.projectId = input.projectId;
    this.steps = input.steps;
    this.policy = input.policy;
  }

  /* -- public reads -------------------------------------------------------- */

  snapshot(): TerminalSessionSnapshot {
    return {
      id: this.id,
      cwd: this.cwd,
      state: this.state,
      steps: this.steps.map((step) => ({ ...step })),
      lines: this.lines.map((line) => ({ ...line })),
      totalLines: this.total,
      droppedLines: this.dropped,
      url: this.url,
      projectId: this.projectId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  subscribe(listener: (event: TerminalStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isFinished(): boolean {
    return this.finished;
  }

  /**
   * The live state, unread by control-flow analysis. `stop()` and `ingest()`
   * mutate `state` from other callbacks while `runStep` is awaiting a child
   * process, so reading the field directly inside that method would be reading
   * a value TypeScript believes cannot have changed.
   */
  private get current(): TerminalSessionState {
    return this.state;
  }

  /* -- lifecycle ----------------------------------------------------------- */

  /** Run the sequence. Called once, right after construction. */
  start(): void {
    this.push('system', null, `$ cd ${this.cwd}`);
    for (const step of this.steps) {
      this.push('system', null, `queued · ${step.command}`);
    }
    void this.runStep();
  }

  private async runStep(): Promise<void> {
    const step = this.steps[this.index];
    if (!step) {
      this.finish('ready');
      return;
    }

    const check = validateCommand(step.command, this.policy);
    if (!check.ok) {
      step.state = 'failed';
      step.finishedAt = nowIso();
      this.push('system', step.id, `refused · ${check.message}`);
      this.finish('failed');
      return;
    }

    step.state = 'running';
    step.startedAt = nowIso();
    this.touch();
    this.push('system', step.id, `$ ${step.command}`);

    const isLast = this.index === this.steps.length - 1;
    let outcome: StepState = 'failed';

    try {
      const child = spawn(check.binary, check.argv, {
        cwd: this.cwd,
        detached: process.platform !== 'win32',
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // No colour codes in a log the browser renders, and no interactive
          // prompts: a session nobody can answer must not wait for one.
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          TERM: 'dumb',
          npm_config_progress: 'false',
          npm_config_update_notifier: 'false',
          WIREUP_TERMINAL: '1',
        },
      });

      this.child = child;
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => this.ingest(chunk, 'stdout', step));
      child.stderr?.on('data', (chunk: string) => this.ingest(chunk, 'stderr', step));

      // Both handlers resolve, and the resolution carries the outcome: a spawn
      // that fails outright (ENOENT — npm not on PATH) emits `error` and may
      // never emit `close`, and a session stuck in "running" with no process
      // behind it is worse than one that reports the failure and stops.
      outcome = await new Promise<StepState>((resolve) => {
        child.on('error', (error) => {
          this.push('system', step.id, `could not start "${check.binary}": ${error.message}`);
          step.state = 'failed';
          step.finishedAt = nowIso();
          this.child = null;
          resolve('failed');
        });
        child.on('close', (code, signal) => {
          step.exitCode = code;
          step.finishedAt = nowIso();
          const next: StepState = this.current === 'stopped' ? 'skipped' : code === 0 ? 'done' : 'failed';
          step.state = next;
          this.push(
            'system',
            step.id,
            `${step.command} exited${signal ? ` on ${signal}` : ''} with code ${code === null ? 'null' : code}`,
          );
          this.child = null;
          resolve(next);
        });
      });
    } catch (error) {
      step.state = 'failed';
      step.finishedAt = nowIso();
      this.push('system', step.id, `spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      this.finish('failed');
      return;
    }

    // Read through the getter: `stop()` can flip the state while this method is
    // awaiting the child, and control-flow analysis would otherwise still see
    // the value this method started with.
    if (this.current === 'stopped') {
      this.finish('stopped');
      return;
    }

    if (outcome === 'failed') {
      this.push(
        'system',
        step.id,
        'Stopping here — the next command would run against a folder the previous one left broken.',
      );
      this.finish('failed');
      return;
    }

    // A long-running dev server never exits, so "the sequence is over" is
    // detected by the URL it prints. Everything after that point is the server
    // talking, and the session stays open to keep streaming it.
    if (isLast && this.url) {
      this.finish('ready');
      return;
    }

    this.index += 1;
    void this.runStep();
  }

  /** Stop the current process group and mark the session stopped. */
  stop(reason = 'stopped from the site'): void {
    if (this.finished) return;
    this.state = 'stopped';
    this.push('system', null, `stopping · ${reason}`);
    this.killChild();
    for (const step of this.steps) {
      if (step.state === 'queued') step.state = 'skipped';
      if (step.state === 'running') {
        step.state = 'skipped';
        step.finishedAt = nowIso();
      }
    }
    this.finish('stopped');
  }

  /** Raw stdin — for the odd interactive prompt a dev server insists on. */
  write(data: string): boolean {
    const child = this.child;
    if (!child?.stdin?.writable) return false;
    child.stdin.write(data.endsWith('\n') ? data : `${data}\n`);
    this.push('system', null, `> ${data.trim()}`);
    return true;
  }

  private killChild(): void {
    const child = this.child;
    if (!child || child.killed) return;
    const pid = child.pid;
    try {
      if (process.platform === 'win32') {
        if (pid) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else if (pid) {
        // Negative pid = the whole group, which is where Vite actually lives.
        process.kill(-pid, 'SIGTERM');
      } else {
        child.kill('SIGTERM');
      }
    } catch (error) {
      logger.warn({ err: error, cwd: this.cwd }, 'terminal: SIGTERM failed, falling back to child.kill');
      child.kill('SIGTERM');
    }
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => {
      try {
        if (pid && process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 4000);
    this.killTimer.unref?.();
  }

  private finish(state: TerminalSessionState): void {
    if (this.finished) return;
    this.finished = true;
    this.state = state;
    this.touch();
    if (this.killTimer) clearTimeout(this.killTimer);
    this.emit({ type: 'closed', reason: state });
    this.listeners.clear();
  }

  /* -- output -------------------------------------------------------------- */

  private ingest(chunk: string, stream: LineStream, step: TerminalStep): void {
    for (const raw of chunk.split(/\r\n|\n|\r/)) {
      const text = raw.replace(ANSI, '').replace(/\s+$/, '');
      if (text.length === 0) continue;
      this.push(stream, step.id, text);
      if (!this.url) {
        const match = LOCAL_URL.exec(text);
        if (match?.[1]) {
          this.url = match[1].replace(/[,;.)\]]+$/, '');
          step.url = this.url;
          this.push('system', step.id, `dev server detected at ${this.url}`);
          // The moment a URL exists the site can frame it, so say so at once
          // rather than waiting for the process to settle.
          if (this.state === 'running') {
            this.state = 'ready';
            this.emit({ type: 'state', snapshot: this.snapshot() });
          }
        }
      }
    }
  }

  private push(stream: LineStream, stepId: string | null, text: string): void {
    this.seq += 1;
    this.total += 1;
    const line: TerminalLine = { seq: this.seq, at: nowIso(), stream, stepId, text };
    this.lines.push(line);
    if (this.lines.length > this.policy.maxLines) {
      const overflow = this.lines.length - this.policy.maxLines;
      this.lines.splice(0, overflow);
      this.dropped += overflow;
    }
    this.touch();
    this.emit({ type: 'line', line });
  }

  private touch(): void {
    this.updatedAt = nowIso();
  }

  private emit(event: TerminalStreamEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        logger.warn({ err: error }, 'terminal: subscriber threw');
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

export type CreateSessionInput = {
  cwd: string;
  projectId?: string | null;
  /** Override the derived sequence. Each entry must pass the command guard. */
  commands?: string[];
  /** Skip the install step when node_modules already exists. */
  skipInstallIfPresent?: boolean;
};

export type CreateSessionResult = { ok: true; session: Session; reused: boolean } | { ok: false; message: string };

function stepId(index: number, command: string): string {
  return `s${index + 1}-${command.replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}`;
}

function labelFor(command: string, index: number): string {
  if (/\b(install|i|ci|add)\b/.test(command) && index === 0) return 'Install dependencies';
  if (/\brun dev\b|\bdev\b|\bstart\b/.test(command)) return 'Start the dev server';
  return command;
}

/**
 * Start (or rejoin) a session in a folder.
 *
 * Rejoining matters: clicking "run" twice must not start a second `npm install`
 * in the same folder, which would race the first one over node_modules.
 */
export function createSession(input: CreateSessionInput): CreateSessionResult {
  const policy = terminalPolicy();
  if (!policy.enabled) {
    return { ok: false, message: 'The terminal is disabled on this server (WIREUP_TERMINAL_ENABLED=0).' };
  }

  const sessions = registry();

  for (const existing of sessions.values()) {
    if (existing.cwd === input.cwd && !existing.isFinished()) {
      return { ok: true, session: existing, reused: true };
    }
  }

  const live = [...sessions.values()].filter((session) => !session.isFinished());
  if (live.length >= policy.maxSessions) {
    return {
      ok: false,
      message: `${live.length} terminal session(s) are already running. Stop one before starting another.`,
    };
  }

  const commands = input.commands?.length
    ? input.commands
    : defaultCommands(input.cwd, input.skipInstallIfPresent ?? false);

  if (commands.length === 0) {
    return { ok: false, message: `Nothing to run in ${input.cwd} — there is no package.json and no install to do.` };
  }

  for (const command of commands) {
    const check = validateCommand(command, policy);
    if (!check.ok) return { ok: false, message: check.message };
  }

  const id = `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const session = new Session({
    id,
    cwd: input.cwd,
    projectId: input.projectId ?? null,
    policy,
    steps: commands.map((command, index) => ({
      id: stepId(index, command),
      command,
      label: labelFor(command, index),
      state: 'queued',
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      url: null,
    })),
  });

  sessions.set(id, session);
  hookProcessExit();
  session.start();
  logger.info({ cwd: input.cwd, commands, id }, 'terminal: session started');
  return { ok: true, session, reused: false };
}

/**
 * The sequence for a folder, derived from the folder.
 *
 * `npm install` then `npm run dev` is the answer for a plain project; the
 * lockfile chooses the manager and package.json chooses the dev script, because
 * running `npm install` in a pnpm project produces a folder that will not start.
 */
export function defaultCommands(folder: string, skipInstallIfPresent: boolean): string[] {
  const commands: string[] = [];
  const hasManifest = fs.existsSync(path.join(folder, 'package.json'));
  const hasModules = fs.existsSync(path.join(folder, 'node_modules'));

  if (hasManifest || !hasModules) {
    const install = installCommandFor(folder);
    if (!(skipInstallIfPresent && hasModules)) commands.push(install);
  }

  const dev = hasManifest ? devCommandFor(folder) : null;
  if (dev) commands.push(dev);
  else if (hasManifest) commands.push('npm run dev');

  return commands;
}

export function getSession(id: string): Session | undefined {
  return registry().get(id);
}

export function listSessions(): TerminalSessionSnapshot[] {
  return [...registry().values()]
    .map((session) => session.snapshot())
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function pruneFinished(keep = 8): void {
  const sessions = registry();
  const finished = [...sessions.values()].filter((session) => session.isFinished());
  if (finished.length <= keep) return;
  for (const session of finished.slice(0, finished.length - keep)) sessions.delete(session.id);
}

function hookProcessExit(): void {
  if (stash.__wireupTerminalHooked) return;
  stash.__wireupTerminalHooked = true;
  const shutdown = () => {
    for (const session of registry().values()) {
      if (!session.isFinished()) session.stop('the Wireup server is shutting down');
    }
  };
  process.once('exit', shutdown);
  process.once('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });
  process.once('SIGINT', () => {
    shutdown();
    process.exit(0);
  });
}
