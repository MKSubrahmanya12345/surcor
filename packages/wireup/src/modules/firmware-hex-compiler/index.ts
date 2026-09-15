/**
 * Real firmware cross-compiler using arduino-cli.
 *
 * Unlike firmware-compiler/ (which type-checks with host g++ against a stub
 * core), this module produces actual AVR machine code by shelling out to
 * arduino-cli. The resulting .hex file can be loaded into avr8js for real
 * hardware simulation.
 *
 * The gate is used in the validation pipeline when WIREUP_ENABLE_REAL_SIM_LOOP
 * is true. If arduino-cli is not on PATH, it degrades honestly with status
 * `sim_execution_unavailable` — the pipeline continues, just without real sim.
 *
 * Scope: AVR boards only. avr8js executes ATmega machine code; an ESP32/RP2040
 * build produces no .hex and cannot run in this harness, so those controllers
 * are reported as skipped instead of failing a compile that could never feed
 * the simulator anyway.
 *
 * All child-process work is ASYNC: a compile can legitimately take up to two
 * minutes, and this runs inside a Next.js server — the old `execFileSync`
 * froze every concurrent request for the whole build.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

import type { GeneratedCodeFile } from '@/types/project';

const execFileAsync = promisify(execFile);

export interface HexCompileStatus {
  available: boolean;
  compiler?: string;
  version?: string;
  reason?: string;
}

export interface HexCompileResult {
  /** False when the gate was disabled or arduino-cli is not on PATH. */
  ran: boolean;
  ok: boolean;
  /** The hex file content as string (only when ok=true). */
  hexContent?: string;
  /** Compiler version info. */
  compilerInfo?: string;
  durationMs: number;
  /** stdout/stderr from arduino-cli for debugging. */
  output?: string;
  /** Why the gate did not run (disabled, no compiler, …). */
  skippedReason?: string;
}

interface Probe {
  at: number;
  status: HexCompileStatus;
}

let probe: Probe | null = null;
const PROBE_TTL_MS = 60_000;

/** Board FQBN mapping for common controllers. */
const BOARD_FQBN_MAP: Record<string, string> = {
  'arduino-uno': 'arduino:avr:uno',
  'arduino-nano': 'arduino:avr:nano',
  'arduino-mega': 'arduino:avr:mega',
  'arduino-leonardo': 'arduino:avr:leonardo',
  'esp32': 'esp32:esp32:esp32',
  'esp32-s2': 'esp32:esp32:esp32s2',
  'esp32-s3': 'esp32:esp32:esp32s3',
  'esp32-c3': 'esp32:esp32:esp32c3',
  'rp2040': 'rp2040:rp2040:rpipico',
  'rp2040-w': 'rp2040:rp2040:rpipicow',
};

/** Boards the ATmega328P-modelled harness can faithfully execute. */
const SUPPORTED_SIM_FQBNS = new Set(['arduino:avr:uno', 'arduino:avr:nano']);

/** Find arduino-cli, probing at most once a minute. */
export function hexCompilerStatus(): HexCompileStatus {
  if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.status;

  let status: HexCompileStatus = { available: false, reason: 'no arduino-cli found on PATH' };
  try {
    // One short synchronous probe (5s cap, cached for a minute) is acceptable;
    // the actual builds below are async.
    const output = execFileSync('arduino-cli', ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
    const versionMatch = /Version:\s*(\S+)/.exec(output);
    status = { available: true, compiler: 'arduino-cli', version: versionMatch?.[1] ?? 'unknown' };
  } catch {
    /* arduino-cli not available */
  }

  probe = { at: Date.now(), status };
  return status;
}

/** Reset the probe cache (useful for tests). */
export function resetHexCompilerProbe(): void {
  probe = null;
}

/** Resolve board FQBN from component ID or return default. */
function resolveFqbn(controllerComponentId?: string): string {
  if (!controllerComponentId) return BOARD_FQBN_MAP['arduino-uno'];
  const normalized = controllerComponentId.toLowerCase().replace(/[_-]/g, '-');
  for (const [key, fqbn] of Object.entries(BOARD_FQBN_MAP)) {
    if (normalized.includes(key)) return fqbn;
  }
  return BOARD_FQBN_MAP['arduino-uno'];
}

/** Compilable source files, entry point first. */
function compilableFiles(files: GeneratedCodeFile[], entryPoint: string): GeneratedCodeFile[] {
  const sources = files.filter((file) => /\.(ino|cpp|c|h|hpp)$/i.test(file.path));
  const entry = sources.find((file) => file.path === entryPoint);
  const rest = sources.filter((file) => file !== entry);
  return entry ? [entry, ...rest] : sources;
}

/** Strip directory traversal from a model/planner-supplied relative path. */
function safeRelativePath(filePath: string): string | null {
  const normalized = path.normalize(filePath).replace(/\\/g, '/');
  if (path.isAbsolute(normalized) || normalized.split('/').some((segment) => segment === '..')) return null;
  return normalized;
}

export interface CompileToHexInput {
  files: GeneratedCodeFile[];
  entryPoint: string;
  /** Controller component ID to determine board FQBN. */
  controllerComponentId?: string;
  /** Optional libraries to install before compile. */
  libraries?: string[];
}

/**
 * Cross-compile Arduino sketch to .hex using arduino-cli.
 *
 * Creates a temporary sketch directory, writes all files, runs
 * `arduino-cli compile` and returns the hex content. The sketch directory is
 * named after the entry `.ino` — arduino-cli rejects a sketch whose main file
 * does not match its folder name (the old fixed `sketch/` folder broke every
 * project whose entry point was not literally `sketch.ino`).
 */
export async function compileToHex(input: CompileToHexInput): Promise<HexCompileResult> {
  const startedAt = Date.now();

  const status = hexCompilerStatus();
  if (!status.available) {
    return { ran: false, ok: false, durationMs: 0, skippedReason: status.reason };
  }

  const sources = compilableFiles(input.files, input.entryPoint);
  const entry = sources[0];
  if (!entry) {
    return { ran: false, ok: false, durationMs: 0, skippedReason: 'no compilable source file in the code artifact' };
  }

  const fqbn = resolveFqbn(input.controllerComponentId);
  if (!fqbn.startsWith('arduino:avr')) {
    return {
      ran: false,
      ok: false,
      durationMs: 0,
      skippedReason: `real simulation needs an AVR board (avr8js); "${fqbn}" builds no .hex and cannot be emulated here`,
    };
  }
  /*
   * The harness models the ATmega328P register map (ports B/C/D, timer0/1/2,
   * USART0, ADC). Mega (2560) and Leonardo (32u4) hex would load but silently
   * execute against the wrong chip — a worse lie than not running at all.
   */
  if (!SUPPORTED_SIM_FQBNS.has(fqbn)) {
    return {
      ran: false,
      ok: false,
      durationMs: 0,
      skippedReason: `the headless harness emulates ATmega328P boards only; "${fqbn}" is not supported yet`,
    };
  }

  if (!/\.ino$/i.test(entry.path)) {
    return {
      ran: false,
      ok: false,
      durationMs: 0,
      skippedReason: `entry point ${entry.path} is not an .ino sketch — arduino-cli cannot build it as a sketch folder`,
    };
  }

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wireup-hex-compile-'));
  const sketchName = path.basename(entry.path).replace(/\.ino$/i, '') || 'sketch';
  const sketchDir = path.join(workDir, sketchName);
  await fsp.mkdir(sketchDir, { recursive: true });

  try {
    // Write all source files to the sketch directory. The entry .ino lives at
    // the sketch root; siblings keep their relative paths (so
    // `#include "helpers/pins.h"` still resolves) unless two files would
    // collide, in which case the later one is flattened into the root.
    const written = new Set<string>();
    for (const file of sources) {
      const rel = safeRelativePath(file.path);
      const isEntry = file === entry;
      let targetRel = isEntry ? path.basename(file.path) : rel ?? path.basename(file.path);
      if (written.has(targetRel)) targetRel = path.basename(file.path);
      if (written.has(targetRel)) continue; // exact duplicate target — skip honestly
      written.add(targetRel);
      const target = path.join(sketchDir, targetRel);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, file.content, 'utf8');
    }

    const buildDir = path.join(workDir, 'build');

    // Install libraries if specified (best effort — compilation will fail
    // loudly if one is truly needed and missing).
    if (input.libraries && input.libraries.length > 0) {
      for (const lib of input.libraries) {
        try {
          await execFileAsync('arduino-cli', ['lib', 'install', lib], {
            encoding: 'utf8',
            timeout: 60_000,
            maxBuffer: 16 * 1024 * 1024,
          });
        } catch {
          /* non-fatal */
        }
      }
    }

    // Run arduino-cli compile
    const { stdout: compileOutput } = await execFileAsync(
      'arduino-cli',
      ['compile', '--fqbn', fqbn, '--build-path', buildDir, '--output-dir', buildDir, sketchDir],
      { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );

    // Find the generated .hex file
    const hexFiles = (await fsp.readdir(buildDir)).filter((f) => f.endsWith('.hex'));
    if (hexFiles.length === 0) {
      return {
        ran: true,
        ok: false,
        durationMs: Date.now() - startedAt,
        output: compileOutput,
        skippedReason: 'compilation succeeded but no .hex file was produced',
      };
    }

    const hexContent = await fsp.readFile(path.join(buildDir, hexFiles[0]), 'utf8');

    return {
      ran: true,
      ok: true,
      hexContent,
      compilerInfo: status.version,
      durationMs: Date.now() - startedAt,
      output: compileOutput,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = error instanceof Error && 'stderr' in error ? String((error as { stderr?: string }).stderr ?? '') : '';
    const stdout = error instanceof Error && 'stdout' in error ? String((error as { stdout?: string }).stdout ?? '') : '';
    return {
      ran: true,
      ok: false,
      durationMs: Date.now() - startedAt,
      output: `${message}\n${stdout}\n${stderr}`,
      skippedReason: `arduino-cli compile failed: ${(stderr || message).split('\n').find((line) => line.trim()) ?? message}`,
    };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
}
