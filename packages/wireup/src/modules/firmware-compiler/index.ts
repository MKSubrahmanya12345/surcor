/**
 * The firmware compile gate.
 *
 * Generated (or user-edited) firmware is type-checked on the host against the
 * stub Arduino core in `scripts/firmware-shim` — the same declarations as the
 * real core, so a sketch that passes here has no undeclared identifiers, no
 * wrong argument types, no missing prototypes. This is NOT a full target
 * build (no avr-gcc / ESP-IDF in the loop yet); it is the difference between
 * "looks plausible" and "type-checks", and it runs in well under a second.
 *
 * The gate is used in two places:
 *   - the validator (issue code `firmware_compile_error`), which feeds the
 *     fixer, and
 *   - the firmware workbench (chat edits and manual saves) before a revision
 *     is frozen.
 *
 * Everything is synchronous (matching the behavioural emulator's host-exec
 * style) and never throws: an unavailable compiler is an honest status, not
 * an error.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { env } from '@/lib/validation/env';
import type { GeneratedCodeFile } from '@/types/project';

export interface CompileDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface CompileStatus {
  available: boolean;
  compiler?: string;
  reason?: string;
}

export interface CompileResult {
  /** False when the gate was disabled or no compiler is on PATH. */
  ran: boolean;
  ok: boolean;
  compiler?: string;
  durationMs: number;
  diagnostics: CompileDiagnostic[];
  /** Why the gate did not run (disabled, no compiler, …) — for honest UIs. */
  skippedReason?: string;
}

interface Probe {
  at: number;
  status: CompileStatus;
}

let probe: Probe | null = null;
const PROBE_TTL_MS = 60_000;

/** Find a host C++ compiler, probing at most once a minute. */
export function firmwareCompilerStatus(): CompileStatus {
  if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.status;

  let status: CompileStatus = { available: false, reason: 'no C++ compiler found on PATH (install g++ or clang++)' };
  for (const candidate of ['g++', 'clang++']) {
    try {
      execFileSync(candidate, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
      status = { available: true, compiler: candidate };
      break;
    } catch {
      /* try the next candidate */
    }
  }
  if (!fs.existsSync(shimDir())) {
    status = { available: false, reason: 'the firmware shim core (scripts/firmware-shim) is missing from this checkout' };
  }

  probe = { at: Date.now(), status };
  return status;
}

function shimDir(): string {
  return path.join(process.cwd(), 'scripts', 'firmware-shim');
}

/** Compilable source files, entry point first. */
function compilableFiles(files: GeneratedCodeFile[], entryPoint: string): GeneratedCodeFile[] {
  const sources = files.filter((file) => /\.(ino|cpp|c|h|hpp)$/i.test(file.path));
  const entry = sources.find((file) => file.path === entryPoint);
  const rest = sources.filter((file) => file !== entry);
  return entry ? [entry, ...rest] : sources;
}

export function compileFirmware(input: { files: GeneratedCodeFile[]; entryPoint: string }): CompileResult {
  const startedAt = Date.now();
  const diagnostics: CompileDiagnostic[] = [];

  if (!env().agent.enableFirmwareCompile) {
    return { ran: false, ok: true, durationMs: 0, diagnostics, skippedReason: 'Disabled by configuration (WIREUP_ENABLE_FIRMWARE_COMPILE=false).' };
  }

  const status = firmwareCompilerStatus();
  if (!status.available) {
    return { ran: false, ok: true, durationMs: 0, diagnostics, skippedReason: status.reason };
  }

  const sources = compilableFiles(input.files, input.entryPoint);
  const entry = sources[0];
  if (!entry) {
    return { ran: false, ok: true, durationMs: 0, diagnostics, skippedReason: 'no compilable source file in the code artifact.' };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wireup-compile-'));
  try {
    for (const file of sources) {
      const target = path.join(dir, path.basename(file.path));
      fs.writeFileSync(target, file.content);
    }
    try {
      execFileSync(
        status.compiler as string,
        ['-std=gnu++17', '-fsyntax-only', '-fpermissive', '-x', 'c++', `-I${shimDir()}`, path.join(dir, path.basename(entry.path))],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
      );
      return { ran: true, ok: true, compiler: status.compiler, durationMs: Date.now() - startedAt, diagnostics };
    } catch (error) {
      const output = error instanceof Error && 'stdout' in error ? String((error as { stdout?: string }).stdout ?? '') : '';
      const stderr = error instanceof Error && 'stderr' in error ? String((error as { stderr?: string }).stderr ?? '') : '';
      const parsed = parseDiagnostics(`${output}\n${stderr}`, sources.map((file) => path.basename(file.path)));
      diagnostics.push(...parsed);
      return {
        ran: true,
        /*
         * The compiler exited non-zero (or timed out) — that is a failure even
         * when no gcc-style diagnostic line survives the known-file filter
         * (errors inside shim headers, an oversized sketch, a killed process).
         * The previous `diagnostics.every(...)` scored an empty list as ok and
         * silently turned a rejected build into a passed gate.
         */
        ok: false,
        compiler: status.compiler,
        durationMs: Date.now() - startedAt,
        diagnostics,
        ...(diagnostics.length === 0
          ? { skippedReason: `the compiler exited non-zero without parseable diagnostics: ${(stderr || output || String(error)).split('\n').find((line) => line.trim()) ?? 'unknown error'}` }
          : {}),
      };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Parse gcc-style diagnostics: `file:line:col: severity: message`.
 * Only lines that reference one of the compiled files are kept — anything
 * else is shim noise (the stub core itself compiling on a stricter host).
 */
export function parseDiagnostics(output: string, knownFiles: string[]): CompileDiagnostic[] {
  const known = new Set(knownFiles);
  const diagnostics: CompileDiagnostic[] = [];
  const pattern = /^([^:\n]+):(\d+):(\d+):\s*(error|warning|fatal error):\s*(.+)$/gm;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    const file = path.basename(match[1] ?? '');
    if (!known.has(file)) continue;
    diagnostics.push({
      file,
      line: Number.parseInt(match[2] ?? '0', 10) || 0,
      column: Number.parseInt(match[3] ?? '0', 10) || 0,
      severity: /error/i.test(match[4] ?? '') ? 'error' : 'warning',
      message: (match[5] ?? '').trim(),
    });
  }
  return diagnostics;
}

/** Render a diagnostic the way the chat and the fixer quote it. */
export function formatDiagnostic(diagnostic: CompileDiagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.severity}: ${diagnostic.message}`;
}
