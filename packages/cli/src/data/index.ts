import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Vendored bundles are inlined into the single-file build by esbuild —
// advisory data ships in the npm package; updates arrive as npm releases.
// That release cadence IS the data pipeline (no runtime API, ever).
import axiosMar26 from './incidents/axios-mar26.json' with { type: 'json' };
import nodeIpcMay26 from './incidents/node-ipc-may26.json' with { type: 'json' };
import shaiHuludJun26 from './incidents/shai-hulud-jun26.json' with { type: 'json' };

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

const VENDORED: IncidentBundle[] = [axiosMar26, nodeIpcMay26, shaiHuludJun26];

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
