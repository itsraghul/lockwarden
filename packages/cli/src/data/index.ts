import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Vendored bundles are inlined into the single-file build by esbuild —
// advisory data ships in the npm package; updates arrive as npm releases.
// That release cadence IS the data pipeline (no runtime API, ever).
// incidents/index.ts is GENERATED — scripts/generate-incident-index.ts.
import { VENDORED_INCIDENTS } from './incidents/index.ts';
import osvSnapshot from './osv-npm-snapshot.json' with { type: 'json' };

export interface IncidentPackage {
  name: string;
  versions?: string[];
  ranges?: string[];
}

export interface IncidentBundle {
  id: string;
  name: string;
  date: string;
  summary: string;
  references?: string[];
  packages: IncidentPackage[];
  fileIocs?: Array<{ path: string; sha256: string }>;
}

const VENDORED: IncidentBundle[] = VENDORED_INCIDENTS;

/**
 * All known incident bundles. LOCKWARDEN_INCIDENT_DIR may add local bundles
 * (used by tests and by teams staging a bundle before it ships in a release);
 * it never replaces the vendored set.
 */
export function loadIncidents(): Map<string, IncidentBundle> {
  const incidents = new Map<string, IncidentBundle>();
  for (const bundle of VENDORED) {
    incidents.set(bundle.id, bundle);
  }
  const extraDir = process.env.LOCKWARDEN_INCIDENT_DIR;
  if (extraDir) {
    for (const file of readdirSync(extraDir)) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue;
      const bundle = JSON.parse(readFileSync(join(extraDir, file), 'utf8')) as IncidentBundle;
      incidents.set(bundle.id, bundle);
    }
  }
  return incidents;
}

/**
 * One entry in the vendored OSV npm snapshot (a subset of OSV.dev data,
 * npm ecosystem only). Entries with neither `versions` nor `ranges` — or a
 * `"*"` range — flag every version of the package.
 */
export interface OsvEntry {
  id: string;
  package: string;
  versions?: string[];
  ranges?: string[];
  summary: string;
}

/**
 * Vendored OSV snapshot, inlined into the single-file build by esbuild.
 * The seed data is refreshed at release time — release cadence IS the
 * data pipeline (no runtime API, ever).
 */
export function loadOsvSnapshot(): OsvEntry[] {
  return osvSnapshot as OsvEntry[];
}
