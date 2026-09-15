/**
 * What the terminal is allowed to do.
 *
 * The dock spawns real processes on the machine running Wireup, so this module
 * is the only thing standing between a browser tab and a shell. Two rules, both
 * checked on every request rather than trusted from the client:
 *
 *   1. the folder has to be inside an allowed root (`WIREUP_TERMINAL_ROOTS`,
 *      default: this repo and the user's home directory), and has to exist;
 *   2. the command has to start with a package manager or a node binary and
 *      contain no shell metacharacters — no `;`, `|`, `&&`, `$()`, backticks,
 *      redirection. The sequence the dock runs is `install` then `dev`, both
 *      derived from the folder itself; anything else has to be explicitly
 *      unlocked with `WIREUP_TERMINAL_FREEFORM=1`.
 *
 * Symlinks are resolved before the containment check, so a link inside an
 * allowed root cannot point the session at /etc.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TerminalPolicy {
  enabled: boolean;
  /** Absolute, realpath'd roots a session's cwd must live inside. */
  roots: string[];
  /** Unlock arbitrary commands. Off by default. */
  freeform: boolean;
  maxSessions: number;
  /** Lines kept per session before the oldest are dropped. */
  maxLines: number;
}

/** Binaries a command may start with when freeform is off. */
const ALLOWED_BINARIES = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'corepack']);

const METACHARACTERS = /[;|&$`<>()[\]{}!\\\n\r]/;

function truthy(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v !== undefined && v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

function realpathSafe(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

export function terminalPolicy(): TerminalPolicy {
  const configured = process.env.WIREUP_TERMINAL_ROOTS?.trim();
  const roots = (configured ? configured.split(path.delimiter) : [process.cwd(), os.homedir()])
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => realpathSafe(root.startsWith('~') ? path.join(os.homedir(), root.slice(1)) : path.resolve(root)));

  const maxSessions = Number.parseInt(process.env.WIREUP_TERMINAL_MAX_SESSIONS ?? '3', 10);
  const maxLines = Number.parseInt(process.env.WIREUP_TERMINAL_MAX_LINES ?? '6000', 10);

  return {
    // Opt out entirely with WIREUP_TERMINAL_ENABLED=0 — the dock then reports
    // that the terminal is disabled instead of failing on the first click.
    enabled: process.env.WIREUP_TERMINAL_ENABLED === undefined ? true : truthy(process.env.WIREUP_TERMINAL_ENABLED),
    roots: roots.length > 0 ? roots : [realpathSafe(process.cwd())],
    freeform: truthy(process.env.WIREUP_TERMINAL_FREEFORM),
    maxSessions: Number.isFinite(maxSessions) && maxSessions > 0 ? Math.min(maxSessions, 16) : 3,
    maxLines: Number.isFinite(maxLines) && maxLines > 100 ? Math.min(maxLines, 50_000) : 6000,
  };
}

export type FolderCheck = { ok: true; path: string } | { ok: false; message: string };

/** Absolute, existing, allowed directory — or the reason it is not. */
export function resolveFolder(input: string, policy: TerminalPolicy = terminalPolicy()): FolderCheck {
  const raw = input?.trim();
  if (!raw) return { ok: false, message: 'Pick a folder first.' };

  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  const absolute = path.resolve(expanded);

  // Containment is checked on the resolved path AND on its realpath, so neither
  // `../` nor a symlink can walk the session out of an allowed root.
  const inside = (candidate: string) =>
    policy.roots.some((root) => candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep));

  if (!inside(absolute)) {
    return {
      ok: false,
      message: `That folder is outside the allowed roots (${policy.roots.join(', ')}). Set WIREUP_TERMINAL_ROOTS to widen them.`,
    };
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(absolute);
  } catch {
    return { ok: false, message: `No such folder: ${absolute}` };
  }
  if (!stats.isDirectory()) return { ok: false, message: `Not a folder: ${absolute}` };

  const real = realpathSafe(absolute);
  if (!inside(real)) {
    return { ok: false, message: `That folder is a link out of the allowed roots: ${real}` };
  }

  return { ok: true, path: real };
}

export type CommandCheck =
  | { ok: true; command: string; argv: string[]; binary: string }
  | { ok: false; message: string };

/**
 * Split a command line into argv, refusing anything that needs a shell.
 *
 * The dock only ever asks for `npm install`-shaped commands, so quoting rules
 * are not implemented: a token with spaces is rejected rather than guessed at.
 */
export function validateCommand(command: string, policy: TerminalPolicy = terminalPolicy()): CommandCheck {
  const trimmed = command?.trim().replace(/\s+/g, ' ');
  if (!trimmed) return { ok: false, message: 'No command was given.' };

  const tokens = trimmed.split(' ');
  const binary = path.basename(tokens[0] as string);

  if (!policy.freeform) {
    if (!ALLOWED_BINARIES.has(binary)) {
      return {
        ok: false,
        message: `"${binary}" is not one of the allowed commands (${[...ALLOWED_BINARIES].join(', ')}). Set WIREUP_TERMINAL_FREEFORM=1 to allow anything.`,
      };
    }
    for (const token of tokens) {
      if (METACHARACTERS.test(token)) {
        return {
          ok: false,
          message: `Refusing to run "${trimmed}": it contains a shell metacharacter. Set WIREUP_TERMINAL_FREEFORM=1 to allow it.`,
        };
      }
    }
  }

  return { ok: true, command: trimmed, argv: tokens.slice(1), binary };
}

/** The install command a folder implies, from its lockfile. */
export function installCommandFor(folder: string): string {
  const has = (name: string) => fs.existsSync(path.join(folder, name));
  if (has('pnpm-lock.yaml')) return 'pnpm install';
  if (has('yarn.lock')) return 'yarn install';
  if (has('bun.lockb') || has('bun.lock')) return 'bun install';
  return 'npm install';
}

/** The dev command a folder implies, from its package.json scripts. */
export function devCommandFor(folder: string): string | null {
  const manager = installCommandFor(folder).split(' ')[0] as string;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = manifest.scripts ?? {};
    if (scripts.dev) return `${manager} run dev`;
    if (scripts.start) return `${manager} start`;
    return null;
  } catch {
    return null;
  }
}
