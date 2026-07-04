/**
 * Pure drift-detection rules: given a base lockfile graph (from a git ref)
 * and the current working-tree graph (plus the two package.json manifests),
 * flag the lockfile-tampering shapes from spec §2.3. No filesystem, no git,
 * no network — everything here unit-tests against in-memory graphs.
 */
import semver from 'semver';
import { type ResolutionGraph, makeKey, splitNameSpec } from '../lockfile/types.js';
import { SEV_RANK, type Severity } from '../scoring/weights.js';
import { type LockfileDiff, diffGraphs } from './lockdiff.js';

export type DriftKind =
  | 'unexplained-version'
  | 'integrity-swap'
  | 'resolved-url-move'
  | 'patch-introduced-dep';

export interface DriftFinding {
  kind: DriftKind;
  severity: Severity;
  /** name or name@version of the affected package. */
  package?: string;
  detail: string;
  evidence?: Record<string, string>;
}

export interface DriftInput {
  base: ResolutionGraph;
  current: ResolutionGraph;
  /** Parsed package.json at the base ref, when available. */
  baseManifest?: Record<string, unknown>;
  /** Parsed package.json in the working tree, when available. */
  currentManifest?: Record<string, unknown>;
}

/** All rules, sorted worst-severity first (stable within a severity). */
export function computeDriftFindings(input: DriftInput): DriftFinding[] {
  const diff = diffGraphs(input.base, input.current);
  const findings: DriftFinding[] = [
    ...integritySwapFindings(input.base, input.current),
    ...unexplainedVersionFindings(input, diff),
    ...resolvedUrlMoveFindings(input.base, input.current, diff),
    ...bumpIntroducedDepFindings(diff),
  ];
  return findings.sort(
    (a, b) =>
      SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
      a.kind.localeCompare(b.kind) ||
      (a.package ?? '').localeCompare(b.package ?? ''),
  );
}

/* ------------------------- rule: integrity-swap ------------------------- */

/**
 * Same name@version present in both graphs but the integrity hash differs.
 * A version that did not change has no honest reason to change content —
 * the classic tamper signal. Critical.
 */
export function integritySwapFindings(
  base: ResolutionGraph,
  current: ResolutionGraph,
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const [key, pkg] of current.packages) {
    const basePkg = base.packages.get(key);
    if (basePkg === undefined) continue;
    if (basePkg.integrity === undefined || pkg.integrity === undefined) continue;
    if (basePkg.integrity === pkg.integrity) continue;
    findings.push({
      kind: 'integrity-swap',
      severity: 'critical',
      package: key,
      detail: `integrity hash changed for unchanged version ${key}`,
      evidence: { baseIntegrity: basePkg.integrity, currentIntegrity: pkg.integrity },
    });
  }
  return findings;
}

/* ----------------------- rule: unexplained-version ---------------------- */

const MANIFEST_DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** The range a manifest declares for a package name, if any section has it. */
export function manifestRange(
  manifest: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  if (manifest === undefined) return undefined;
  for (const section of MANIFEST_DEP_SECTIONS) {
    const deps = manifest[section];
    if (typeof deps !== 'object' || deps === null) continue;
    const range = (deps as Record<string, unknown>)[name];
    if (typeof range === 'string') return range;
  }
  return undefined;
}

/**
 * A resolved version changed and no manifest explains it:
 * - direct dep: the package.json range is UNCHANGED from base and the new
 *   version does NOT satisfy it (a changed range is an intentional bump);
 * - transitive: the new version satisfies NO inbound edge range in the
 *   current graph (a parent that widened its range explains the move).
 * Non-semver ranges (git:, file:, workspace:) cannot be judged and are
 * conservatively treated as explaining the version. High.
 */
export function unexplainedVersionFindings(input: DriftInput, diff: LockfileDiff): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const [name, change] of diff.changed) {
    const currentRange = manifestRange(input.currentManifest, name);
    if (currentRange !== undefined) {
      // Direct dependency: judge against package.json.
      const baseRange = manifestRange(input.baseManifest, name);
      if (baseRange !== currentRange) continue; // intentional bump
      if (semver.validRange(currentRange) === null) continue; // cannot judge
      if (semver.satisfies(change.to, currentRange)) continue;
      findings.push({
        kind: 'unexplained-version',
        severity: 'high',
        package: makeKey(name, change.to),
        detail: `${name} moved ${change.from} → ${change.to} but package.json still requires ${currentRange} (lockfile-only change outside the declared range)`,
        evidence: { from: change.from, to: change.to, range: currentRange },
      });
      continue;
    }

    // Transitive: judge against every inbound edge range in the current graph.
    const key = makeKey(name, change.to);
    const inbound = input.current.inbound.get(key) ?? [];
    if (inbound.length === 0) continue; // no edges to judge against
    let explained = false;
    for (const edge of inbound) {
      if (semver.validRange(edge.range) === null || semver.satisfies(change.to, edge.range)) {
        explained = true;
        break;
      }
    }
    if (explained) continue;
    const ranges = [...new Set(inbound.map((e) => e.range))].join(', ');
    findings.push({
      kind: 'unexplained-version',
      severity: 'high',
      package: key,
      detail: `${name} moved ${change.from} → ${change.to} but satisfies none of its inbound ranges (${ranges})`,
      evidence: { from: change.from, to: change.to, inboundRanges: ranges },
    });
  }
  return findings;
}

/* ------------------------ rule: resolved-url-move ------------------------ */

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * The resolved tarball URL for a package moved. A host change (registry →
 * elsewhere) is High wherever it appears — including across a version bump,
 * where the path legitimately changes but the host must not. A path-only
 * change for the SAME version is Med.
 */
export function resolvedUrlMoveFindings(
  base: ResolutionGraph,
  current: ResolutionGraph,
  diff: LockfileDiff,
): DriftFinding[] {
  const findings: DriftFinding[] = [];

  // Same name@version in both graphs, resolved URL differs.
  for (const [key, pkg] of current.packages) {
    const basePkg = base.packages.get(key);
    if (basePkg === undefined) continue;
    if (basePkg.resolved === undefined || pkg.resolved === undefined) continue;
    if (basePkg.resolved === pkg.resolved) continue;
    const baseHost = hostOf(basePkg.resolved);
    const currentHost = hostOf(pkg.resolved);
    const hostMoved =
      baseHost !== undefined && currentHost !== undefined && baseHost !== currentHost;
    findings.push({
      kind: 'resolved-url-move',
      severity: hostMoved ? 'high' : 'med',
      package: key,
      detail: hostMoved
        ? `${key} tarball host moved ${baseHost} → ${currentHost} for an unchanged version`
        : `${key} tarball URL path changed for an unchanged version`,
      evidence: { baseResolved: basePkg.resolved, currentResolved: pkg.resolved },
    });
  }

  // Version changed: the path changes legitimately, but the host must not.
  for (const [name, change] of diff.changed) {
    const pkg = current.packages.get(makeKey(name, change.to));
    if (change.baseResolved === undefined || pkg?.resolved === undefined) continue;
    const baseHost = hostOf(change.baseResolved);
    const currentHost = hostOf(pkg.resolved);
    if (baseHost === undefined || currentHost === undefined || baseHost === currentHost) continue;
    findings.push({
      kind: 'resolved-url-move',
      severity: 'high',
      package: makeKey(name, change.to),
      detail: `${name} tarball host moved ${baseHost} → ${currentHost} across the ${change.from} → ${change.to} bump`,
      evidence: { baseResolved: change.baseResolved, currentResolved: pkg.resolved },
    });
  }

  return findings;
}

/* ---------------------- rule: patch-introduced-dep ---------------------- */

/** 'patch' | 'minor' for a clean patch/minor bump, null otherwise. */
export function bumpKind(from: string, to: string): 'patch' | 'minor' | null {
  if (semver.valid(from) === null || semver.valid(to) === null) return null;
  if (!semver.gt(to, from)) return null;
  const kind = semver.diff(from, to);
  return kind === 'patch' || kind === 'minor' ? kind : null;
}

/**
 * A new package entered the tree while an existing dep took a patch/minor
 * bump — the axios → plain-crypto-js shape: nobody re-reviews a patch bump,
 * and that is where the payload rides in. diffGraphs() precomputes the
 * patch-only subset (addedTransitiveUnderPatch); minor bumps are folded in
 * here. High.
 */
export function bumpIntroducedDepFindings(diff: LockfileDiff): DriftFinding[] {
  const bumped: string[] = [];
  for (const [name, change] of diff.changed) {
    if (bumpKind(change.from, change.to) !== null) {
      bumped.push(`${name} ${change.from} → ${change.to}`);
    }
  }
  if (bumped.length === 0) return [];

  const findings: DriftFinding[] = [];
  for (const key of diff.added) {
    const { name } = splitNameSpec(key);
    if (diff.changed.has(name)) continue; // its own version change, not an arrival
    findings.push({
      kind: 'patch-introduced-dep',
      severity: 'high',
      package: key,
      detail: `new package ${key} entered the tree alongside patch/minor bump(s): ${bumped.join(', ')}`,
      evidence: { bumps: bumped.join(', ') },
    });
  }
  return findings;
}
