/**
 * Minimal `.env` loader for the plain Node/tsx scripts in `scripts/`.
 *
 * Next.js loads `.env` for the app itself; the standalone scripts do not run
 * through Next, so they use this. Existing process env always wins, so CI and
 * container deployments are never silently overridden.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Returns `file:KEY` for every variable that was actually injected. */
export function loadDotEnv(cwd: string): string[] {
  const loaded: string[] = [];

  for (const filename of ['.env.local', '.env']) {
    const path = resolve(cwd, filename);
    if (!existsSync(path)) continue;

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('#')) continue;
      const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
      const separator = withoutExport.indexOf('=');
      if (separator <= 0) continue;
      const key = withoutExport.slice(0, separator).trim();
      let value = withoutExport.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      if (key.length === 0) continue;
      if (process.env[key] === undefined) {
        process.env[key] = value;
        loaded.push(`${filename}:${key}`);
      }
    }
  }

  return loaded;
}
