/**
 * Layer 2: the known-bad overlay. Structural detection (Layer 1) works with
 * zero advisory data; this layer matches resolved packages against the
 * vendored OSV snapshot and incident IOC bundles. Any hit = critical,
 * regardless of what Layer 1 saw.
 */
import semver from 'semver';
import {
  type IncidentBundle,
  type OsvEntry,
  loadIncidents,
  loadOsvSnapshot,
} from '../data/index.ts';
import type { Layer2Finding } from './types.ts';

export interface Layer2Sources {
  osv: OsvEntry[];
  incidents: IncidentBundle[];
}

/**
 * A package entry with neither exact versions nor ranges flags the package
 * wholesale ("all versions"), as does a '*' range. Semver ranges match with
 * includePrerelease — for a known-bad overlay, over-matching prereleases
 * inside a compromised range is the safe direction.
 */
function versionMatches(version: string, versions?: string[], ranges?: string[]): boolean {
  const hasVersions = (versions?.length ?? 0) > 0;
  const hasRanges = (ranges?.length ?? 0) > 0;
  if (!hasVersions && !hasRanges) return true;
  if (versions?.includes(version)) return true;
  for (const range of ranges ?? []) {
    if (range === '*') return true;
    if (semver.satisfies(version, range, { includePrerelease: true })) return true;
  }
  return false;
}

/** All Layer-2 hits for one resolved package. Every finding is critical. */
export function layer2Findings(
  pkg: { name: string; version: string },
  sources: Layer2Sources,
): Layer2Finding[] {
  const findings: Layer2Finding[] = [];

  for (const entry of sources.osv) {
    if (entry.package !== pkg.name) continue;
    if (!versionMatches(pkg.version, entry.versions, entry.ranges)) continue;
    findings.push({
      layer: 2,
      severity: 'critical',
      code: `LW2-OSV-${entry.id}`,
      package: { name: pkg.name, version: pkg.version },
      layer2: { source: 'osv', id: entry.id, summary: entry.summary },
    });
  }

  for (const incident of sources.incidents) {
    for (const entry of incident.packages) {
      if (entry.name !== pkg.name) continue;
      if (!versionMatches(pkg.version, entry.versions, entry.ranges)) continue;
      findings.push({
        layer: 2,
        severity: 'critical',
        code: `LW2-IOC-${incident.id}`,
        package: { name: pkg.name, version: pkg.version },
        layer2: { source: 'incident', id: incident.id, summary: incident.summary },
      });
      break; // one finding per incident, even if it lists the package twice
    }
  }

  return findings;
}

/** The vendored known-bad sources: OSV snapshot + incident IOC bundles. */
export function loadLayer2Sources(): Layer2Sources {
  return { osv: loadOsvSnapshot(), incidents: [...loadIncidents().values()] };
}
