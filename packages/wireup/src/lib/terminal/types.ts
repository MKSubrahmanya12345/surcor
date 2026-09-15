/**
 * Terminal dock — shared types.
 *
 * The dock is the site's own terminal: the user picks a folder in the page, the
 * server spawns the install and the dev server in it, and the output streams
 * back over SSE. These types are the whole protocol between the two — they are
 * imported by the API routes (server) and the dock (client), so neither side
 * can drift from the other without a type error.
 */

/** One command in the run sequence, and where it got to. */
export type StepState = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

export interface TerminalStep {
  id: string;
  /** Exactly what is spawned, as it will be shown to the user. */
  command: string;
  /** What the step is for, in plain words ("Install dependencies"). */
  label: string;
  state: StepState;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  /** A dev-server URL picked out of this step's output, when there is one. */
  url: string | null;
}

export type LineStream = 'stdout' | 'stderr' | 'system';

export interface TerminalLine {
  seq: number;
  at: string;
  stream: LineStream;
  /** Which step produced it, so the UI can group and colour by step. */
  stepId: string | null;
  text: string;
}

/**
 * `running` — a step is executing.
 * `ready`   — the last step is a long-running server and it printed a URL.
 * `failed`  — a step exited non-zero; the sequence stopped there.
 * `stopped` — the user stopped it (or the server shut the session down).
 */
export type TerminalSessionState = 'running' | 'ready' | 'failed' | 'stopped';

export interface TerminalSessionSnapshot {
  id: string;
  /** Absolute path of the folder the commands run in. */
  cwd: string;
  state: TerminalSessionState;
  steps: TerminalStep[];
  /** The tail of the output — the server keeps a bounded ring buffer. */
  lines: TerminalLine[];
  /** Total lines produced, including the ones the buffer dropped. */
  totalLines: number;
  droppedLines: number;
  /** First URL seen in the output (the dev server, normally). */
  url: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A directory entry from the folder browser. */
export interface BrowseEntry {
  name: string;
  path: string;
  /** True when the directory holds a package.json. */
  isProject: boolean;
  /** True when node_modules already exists (install can be skipped). */
  hasNodeModules: boolean;
  /** The `dev` script from package.json, when there is one. */
  devScript: string | null;
  /** Which install command this folder implies, from its lockfile. */
  installCommand: string;
}

export interface BrowsePayload {
  path: string;
  parent: string | null;
  /** Roots the browser is allowed to walk. */
  roots: string[];
  entries: BrowseEntry[];
  /** The folder itself, as an entry — what "use this folder" would pick. */
  current: BrowseEntry | null;
  error: string | null;
}

/** Events pushed over the SSE stream. */
export type TerminalStreamEvent =
  | { type: 'snapshot'; snapshot: TerminalSessionSnapshot }
  | { type: 'line'; line: TerminalLine }
  | { type: 'state'; snapshot: TerminalSessionSnapshot }
  | { type: 'closed'; reason: string };
