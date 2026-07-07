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
 * The vendored snapshot file: metadata wrapper + entries. `generatedAt` is
 * the date the entry set was produced from upstream — the freshness stamp
 * behind `--max-advisory-age` and the human `advisories:` line. Written by
 * scripts/refresh-osv-snapshot.ts (weekly osv-refresh.yml).
 */
export interface OsvSnapshotFile {
  schemaVersion: 1;
  generatedAt: string;
  source: string;
  windowMonths: number | null;
  entries: OsvEntry[];
}

/**
 * Vendored OSV snapshot, inlined into the single-file build by esbuild.
 * Refreshed via npm releases — release cadence IS the data pipeline
 * (no runtime API, ever).
 */
export function loadOsvSnapshot(): OsvEntry[] {
  return (osvSnapshot as OsvSnapshotFile).entries;
}

/** Ids shipped in THIS build (excludes LOCKWARDEN_INCIDENT_DIR overlays). */
export function vendoredIncidentIds(): Set<string> {
  return new Set(VENDORED.map((bundle) => bundle.id));
}

/** Snapshot metadata without the entry payload (for listings/reports). */
export function osvSnapshotInfo(): {
  generatedAt: string;
  source: string;
  windowMonths: number | null;
  entries: number;
} {
  const file = osvSnapshot as OsvSnapshotFile;
  return {
    generatedAt: file.generatedAt,
    source: file.source,
    windowMonths: file.windowMonths,
    entries: file.entries.length,
  };
}

/**
 * Freshness stamps for the vendored advisory shipment. `osvGeneratedAt` is
 * the refresh-cadenced stamp (the `--max-advisory-age` basis); the newest
 * incident date is event-dated context, not a staleness signal — a quiet
 * month is not stale data. Includes LOCKWARDEN_INCIDENT_DIR overlays.
 */
export function advisoryFreshness(): { osvGeneratedAt: string; newestIncidentDate: string } {
  const osvGeneratedAt = (osvSnapshot as OsvSnapshotFile).generatedAt;
  let newestIncidentDate = '';
  for (const bundle of loadIncidents().values()) {
    // YYYY-MM-DD sorts lexically.
    if (bundle.date > newestIncidentDate) newestIncidentDate = bundle.date;
  }
  return { osvGeneratedAt, newestIncidentDate };
}
