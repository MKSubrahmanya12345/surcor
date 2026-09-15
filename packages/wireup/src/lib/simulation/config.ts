/**
 * Where the two local services live.
 *
 * The /simulation page embeds two things the user runs on their own machine:
 *
 *   Velxio     `external/velxio/frontend` — `npm run dev` → :5174
 *   Dashboard  the zip this build produced — `npm run dev` → :5175
 *
 * Both are addressed by URL, and both default to those ports, because that is
 * what the vendored Velxio's `vite.config.ts` and the generated dashboard's
 * `vite.config.ts` actually bind. Either can be overridden from the
 * environment when a port is already taken.
 *
 * These are BROWSER-side URLs. Wireup's server never fetches them — it cannot;
 * they live on the user's laptop, not on the server. They are handed to the
 * page and used as iframe sources, which is the only thing that works when the
 * two halves are on different machines.
 */

export interface SimulationEndpoints {
  /** Velxio frontend (the emulator canvas). */
  velxioUrl: string;
  /** The generated dashboard's dev server. */
  websiteUrl: string;
  /** Which half the page opens on. */
  defaultView: 'simulation' | 'website';
}

const DEFAULT_VELXIO_URL = 'http://localhost:5174';
const DEFAULT_WEBSITE_URL = 'http://localhost:5175';

function clean(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  try {
    // Normalise so an origin with a trailing slash or a path both work.
    return new URL(trimmed).toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

export function simulationConfig(): SimulationEndpoints {
  const view = process.env.WIREUP_SIM_DEFAULT_VIEW?.trim().toLowerCase();
  return {
    velxioUrl: clean(process.env.WIREUP_VELXIO_URL, DEFAULT_VELXIO_URL),
    websiteUrl: clean(process.env.WIREUP_WEBSITE_URL, DEFAULT_WEBSITE_URL),
    defaultView: view === 'website' ? 'website' : 'simulation',
  };
}
