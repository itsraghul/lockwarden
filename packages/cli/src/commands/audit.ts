import { relative } from 'node:path';
import semver from 'semver';
// Version is injected from package.json at build time by tsup (JSON inline).
import pkgJson from '../../package.json' with { type: 'json' };
import { ALL_ANALYZERS } from '../analyzers/index.js';
import type {
  AnalyzerContext,
  LockfileDiffView,
  PackageArtifact,
  Signal,
} from '../analyzers/types.js';
import { ExecError, ExitCode } from '../exit.js';
import type { GlobalOptions } from '../index.js';
import { dirToArtifact, tarballToArtifact } from '../lib/artifact.js';
import { cachedTarball } from '../lib/cache.js';
import { repoRoot, showFileAt } from '../lib/git.js';
import { diffGraphs, toDiffView } from '../lib/lockdiff.js';
import { registryBase, request, setOffline } from '../lib/net.js';
import { locateInstalled } from '../lib/node-modules.js';
import { bad, bold, configureOutput, dim, paint, printJson, warn } from '../lib/output.js';
import { loadGraph, parseLockfileContent } from '../lockfile/detect.js';
import { type PkgKey, type ResolutionGraph, makeKey } from '../lockfile/types.js';
import { buildRollup, scorePackage } from '../scoring/engine.js';
import { layer2Findings, loadLayer2Sources } from '../scoring/layer2.js';
import { toSarif } from '../scoring/sarif.js';
import { exceedsThreshold, parseThreshold } from '../scoring/threshold.js';
import type { AuditReport, Finding, PackageReport } from '../scoring/types.js';
import type { Grade, Severity } from '../scoring/weights.js';

export interface AuditOptions {
  diff?: string;
  deep?: boolean;
  verbose?: boolean;
}

const PACKAGE_ANALYZERS = ALL_ANALYZERS.filter((a) => a.scope === 'package');
const TREE_ANALYZERS = ALL_ANALYZERS.filter((a) => a.scope === 'tree');

/** Concurrency caps: local disk walks vs explicitly-slow network fetches. */
const DISK_CONCURRENCY = 8;
const FETCH_CONCURRENCY = 4;

export async function runAudit(options: AuditOptions, globals: GlobalOptions): Promise<number> {
  configureOutput({ json: globals.json, ci: globals.ci });
  setOffline(globals.offline);
  // Parse the threshold before any work: a bad value is exit 2, immediately.
  const threshold = parseThreshold(globals.threshold);

  if (options.diff !== undefined && options.deep === true) {
    throw new ExecError(
      '--diff and --deep are mutually exclusive',
      '--diff delta-scores the lockfile diff; --deep delta-scores the whole tree.',
    );
  }

  const dirs = globals.dir.length > 0 ? globals.dir : [process.cwd()];
  const dir = dirs[0] ?? process.cwd();
  const warnings: string[] = [];
  if (dirs.length > 1) {
    warnings.push(
      `audit analyzes one project per run; using ${dir} (${dirs.length - 1} extra --dir ignored)`,
    );
  }

  const graph = await loadGraph(dir);
  warnings.push(...graph.warnings);

  const mode: AuditReport['mode'] =
    options.diff !== undefined ? 'diff' : options.deep === true ? 'deep' : 'absolute';

  // Layer 1: structural signals, keyed by resolved package.
  const signalsByKey = new Map<PkgKey, Signal[]>();
  if (options.diff !== undefined) {
    await collectDiff(dir, graph, options.diff, signalsByKey, warnings);
  } else if (mode === 'deep') {
    await collectDeep(dir, graph, signalsByKey, warnings);
  } else {
    await collectAbsolute(dir, graph, signalsByKey, warnings);
  }

  // Layer 2 matches EVERY resolved package, on disk or not; then score.
  const sources = loadLayer2Sources();
  const reports: PackageReport[] = [];
  for (const key of [...graph.packages.keys()].sort()) {
    const pkg = graph.packages.get(key);
    if (pkg === undefined) continue;
    const layer2 = layer2Findings({ name: pkg.name, version: pkg.version }, sources);
    reports.push(scorePackage(pkg, signalsByKey.get(key) ?? [], layer2));
  }

  const flagged = reports
    .filter((r) => r.findings.length > 0)
    .sort((a, b) => GRADE_RANK[b.grade] - GRADE_RANK[a.grade] || a.key.localeCompare(b.key));
  const rollup = buildRollup(reports, graph.packages.size);

  const report: AuditReport = {
    command: 'audit',
    mode,
    lockfile: { path: graph.lockfilePath, type: graph.lockfileType },
    packages: flagged,
    rollup,
    warnings,
  };

  const exitCode = exceedsThreshold(report, threshold) ? ExitCode.Findings : ExitCode.Clean;

  if (globals.sarif) {
    process.stdout.write(
      `${JSON.stringify(
        toSarif(report, { verbose: options.verbose, toolVersion: pkgJson.version }),
        null,
        2,
      )}\n`,
    );
    return exitCode;
  }
  if (globals.json) {
    printJson(report);
    return exitCode;
  }
  renderHuman(report, globals);
  return exitCode;
}

/* --------------------------- signal collection --------------------------- */

/** Run all package-scope analyzers over one artifact. */
async function analyzePackage(
  pkg: PackageArtifact,
  previous?: PackageArtifact,
  graphDiff?: LockfileDiffView,
): Promise<Signal[]> {
  const ctx: AnalyzerContext = { pkg, previous, graphDiff };
  const signals: Signal[] = [];
  for (const analyzer of PACKAGE_ANALYZERS) {
    if (analyzer.needsPrevious && previous === undefined) continue;
    signals.push(...(await analyzer.analyze(ctx)));
  }
  return signals;
}

/** Bounded-concurrency map; result order does not matter (keyed by package). */
async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const width = Math.min(limit, items.length);
  const workers = Array.from({ length: width }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

function missingWarning(missing: number): string {
  return `${missing} package(s) not present in node_modules — run install for full coverage`;
}

/** Absolute mode: every resolved package, from node_modules, zero network. */
async function collectAbsolute(
  dir: string,
  graph: ResolutionGraph,
  signalsByKey: Map<PkgKey, Signal[]>,
  warnings: string[],
): Promise<void> {
  let missing = 0;
  await mapPool([...graph.packages.values()], DISK_CONCURRENCY, async (pkg) => {
    const installed = await locateInstalled(dir, pkg.name, pkg.version);
    if (installed === null) {
      missing += 1;
      return;
    }
    const artifact = await dirToArtifact(installed);
    const signals = await analyzePackage(artifact);
    if (signals.length > 0) signalsByKey.set(pkg.key, signals);
  });
  if (missing > 0) warnings.push(missingWarning(missing));
}

/** npm-convention tarball URL when a lockfile carries no `resolved` field. */
function fallbackTarballUrl(name: string, version: string): string {
  const basename = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  return `${registryBase()}/${name}/-/${basename}-${version}.tgz`;
}

/** Current contents of a package: node_modules first, registry tarball fallback. */
async function currentArtifact(
  dir: string,
  name: string,
  version: string,
  resolved: string | undefined,
  integrity: string | undefined,
): Promise<PackageArtifact> {
  const installed = await locateInstalled(dir, name, version);
  if (installed !== null) return await dirToArtifact(installed);
  const url = resolved ?? fallbackTarballUrl(name, version);
  return await tarballToArtifact(await cachedTarball(url, integrity), { name, version });
}

/**
 * --diff mode: delta-score ONLY packages whose resolved version changed vs
 * the base ref (network fetches are scoped to their previous tarballs); new
 * arrivals get absolute analysis from node_modules; tree-scope analyzers see
 * the full lockfile diff.
 */
async function collectDiff(
  dir: string,
  graph: ResolutionGraph,
  baseRef: string,
  signalsByKey: Map<PkgKey, Signal[]>,
  warnings: string[],
): Promise<void> {
  const root = await repoRoot(dir);
  const rel = relative(root, graph.lockfilePath);
  const baseContent = await showFileAt(dir, baseRef, rel);
  if (baseContent === null) {
    throw new ExecError(
      `lockfile ${rel} not found at ref '${baseRef}'`,
      '--diff compares the working lockfile against a committed one; check the ref.',
    );
  }
  const baseGraph = parseLockfileContent(baseContent, graph.lockfileType, {
    lockfilePath: graph.lockfilePath,
  });
  const diff = diffGraphs(baseGraph, graph);
  const view = toDiffView(diff);

  // Changed packages: current artifact + previous tarball → delta analysis.
  await mapPool([...diff.changed.entries()], FETCH_CONCURRENCY, async ([name, change]) => {
    const key = makeKey(name, change.to);
    const pkg = graph.packages.get(key);
    const current = await currentArtifact(dir, name, change.to, pkg?.resolved, pkg?.integrity);
    const prevUrl = change.baseResolved ?? fallbackTarballUrl(name, change.from);
    const previous = await tarballToArtifact(await cachedTarball(prevUrl, change.baseIntegrity), {
      name,
      version: change.from,
    });
    const signals = await analyzePackage(current, previous, view);
    if (signals.length > 0) signalsByKey.set(key, signals);
  });

  // New packages (added, not a version change): absolute from node_modules.
  let missing = 0;
  await mapPool([...diff.added], DISK_CONCURRENCY, async (key) => {
    const pkg = graph.packages.get(key);
    if (pkg === undefined) return;
    const installed = await locateInstalled(dir, pkg.name, pkg.version);
    if (installed === null) {
      missing += 1;
      return;
    }
    const artifact = await dirToArtifact(installed);
    const signals = await analyzePackage(artifact, undefined, view);
    if (signals.length > 0) signalsByKey.set(key, signals);
  });
  if (missing > 0) warnings.push(missingWarning(missing));

  // Tree-scope analyzers (dep-introduction) run once over the diff; their
  // signals carry the affected package identity and are merged into it.
  const projectStandIn: PackageArtifact = {
    name: '<project>',
    version: '0.0.0',
    manifest: {},
    files: new Map(),
    totalSize: 0,
  };
  for (const analyzer of TREE_ANALYZERS) {
    const signals = await analyzer.analyze({
      pkg: projectStandIn,
      graphDiff: view,
      graph: { packages: new Set(graph.packages.keys()) },
    });
    for (const signal of signals) {
      const key = makeKey(signal.package.name, signal.package.version);
      const existing = signalsByKey.get(key);
      if (existing === undefined) signalsByKey.set(key, [signal]);
      else existing.push(signal);
    }
  }
}

interface PackumentVersion {
  dist?: { tarball?: string; integrity?: string };
}

/** Registry URL-encoding for a package name (scoped: keep the leading @). */
function encodeName(name: string): string {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

/**
 * The highest PUBLISHED version strictly below `version`, as an artifact —
 * or undefined when none exists. Plain Errors here are per-package warnings;
 * ExecError (incl. OfflineViolationError) always propagates.
 */
async function previousPublished(
  name: string,
  version: string,
): Promise<PackageArtifact | undefined> {
  const response = await request(`${registryBase()}/${encodeName(name)}`);
  if (!response.ok) throw new Error(`packument fetch failed: HTTP ${response.status}`);
  const packument = (await response.json()) as { versions?: Record<string, PackumentVersion> };
  const versions = Object.keys(packument.versions ?? {})
    .filter((v) => semver.valid(v) !== null && semver.lt(v, version))
    .sort(semver.rcompare);
  const prev = versions[0];
  if (prev === undefined) return undefined;
  const dist = packument.versions?.[prev]?.dist;
  const url = dist?.tarball ?? fallbackTarballUrl(name, prev);
  return await tarballToArtifact(await cachedTarball(url, dist?.integrity), {
    name,
    version: prev,
  });
}

/** --deep mode: absolute scan + previous published version of EVERY package. */
async function collectDeep(
  dir: string,
  graph: ResolutionGraph,
  signalsByKey: Map<PkgKey, Signal[]>,
  warnings: string[],
): Promise<void> {
  let missing = 0;
  await mapPool([...graph.packages.values()], FETCH_CONCURRENCY, async (pkg) => {
    let artifact: PackageArtifact;
    const installed = await locateInstalled(dir, pkg.name, pkg.version);
    if (installed !== null) {
      artifact = await dirToArtifact(installed);
    } else if (pkg.resolved !== undefined) {
      artifact = await tarballToArtifact(await cachedTarball(pkg.resolved, pkg.integrity), {
        name: pkg.name,
        version: pkg.version,
      });
    } else {
      missing += 1;
      return;
    }

    let previous: PackageArtifact | undefined;
    try {
      previous = await previousPublished(pkg.name, pkg.version);
    } catch (err) {
      if (err instanceof ExecError) throw err; // offline violation, integrity mismatch
      warnings.push(
        `deep: no previous version comparison for ${pkg.key} (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    const signals = await analyzePackage(artifact, previous);
    if (signals.length > 0) signalsByKey.set(pkg.key, signals);
  });
  if (missing > 0) warnings.push(missingWarning(missing));
}

/* ------------------------------- rendering ------------------------------- */

const GRADE_RANK: Record<Grade, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };

function paintGrade(grade: Grade, text: string): string {
  if (grade === 'A') return paint('green', text);
  if (grade === 'B' || grade === 'C') return warn(text);
  return bad(text);
}

function paintSeverity(severity: Severity): string {
  const label = `[${severity}]`;
  if (severity === 'critical' || severity === 'high') return bad(label);
  if (severity === 'med') return warn(label);
  return dim(label);
}

function findingLine(finding: Finding): string {
  if (finding.layer === 2) {
    return `${paintSeverity(finding.severity)} ${finding.code} — known-bad (${finding.layer2.source}: ${finding.layer2.id}) ${finding.layer2.summary}`;
  }
  const file = finding.signal.evidence.file;
  const where = file === undefined ? '' : ` ${dim(file)}`;
  return `${paintSeverity(finding.severity)} ${finding.signal.code}${where} — ${finding.signal.evidence.detail}`;
}

function countsLine(rollup: AuditReport['rollup']): string {
  const parts: string[] = [];
  for (const severity of ['critical', 'high', 'med', 'low'] as const) {
    const count = rollup.counts[severity];
    if (count > 0) parts.push(`${severity} ${count}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'no findings';
}

function renderHuman(report: AuditReport, globals: GlobalOptions): void {
  const { rollup } = report;
  const plural = rollup.packagesFlagged === 1 ? 'package' : 'packages';
  console.log(
    `${paintGrade(rollup.grade, bold(`grade ${rollup.grade}`))} — ${rollup.packagesFlagged} ${plural} flagged of ${rollup.packagesAnalyzed} analyzed`,
  );
  console.log(dim(countsLine(rollup)));
  if (globals.ci) return;

  const lockRel = relative(process.cwd(), report.lockfile.path) || report.lockfile.path;
  console.log(dim(`lockfile: ${lockRel} (${report.lockfile.type}) — mode: ${report.mode}`));
  for (const warning of report.warnings) console.log(dim(`warning: ${warning}`));

  for (const pkg of report.packages) {
    console.log();
    console.log(`  ${bold(pkg.key)} — ${paintGrade(pkg.grade, `grade ${pkg.grade}`)}`);
    for (const finding of pkg.findings) {
      console.log(`    ${findingLine(finding)}`);
    }
  }
}
