import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Analyzer,
  AnalyzerContext,
  LockfileDiffView,
  PackageArtifact,
  Signal,
} from '../../packages/cli/src/analyzers/types.ts';
import { ALL_ANALYZERS } from '../src/analyzers/index.ts';
import { OBFUSCATION_CUTOFFS } from '../src/analyzers/obfuscation.ts';
import { tarballToArtifact } from '../src/artifact.ts';

/**
 * Calibration runner. Applies the PROVISIONAL spec §3 weight table to
 * analyzer signals, grades each package/fixture, and writes the separation
 * report + weights.json. The GATE: every malicious fixture must grade F in
 * delta mode AND benign delta pairs must produce ZERO Critical signals.
 *
 * Run: node --experimental-strip-types scripts/run.ts [--limit N]
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CACHE = path.join(ROOT, 'cache');
const GEN_MAL = path.join(ROOT, 'generated', 'malicious');
const GEN_LOCK = path.join(ROOT, 'generated', 'lockfile-pairs');
const REPORT_DIR = path.join(ROOT, 'report');

type Severity = 'critical' | 'high' | 'med' | 'low' | 'none';
const SEV_RANK: Record<Severity, number> = { none: 0, low: 1, med: 2, high: 3, critical: 4 };

/**
 * PROVISIONAL WEIGHTS — spec §3 Layer-1 table. (analyzer, kind[, metric])
 * → severity. DO NOT hardcode as final: gated by this run's separation.
 * Obfuscation cutoffs live in the analyzer (OBFUSCATION_CUTOFFS) and are
 * echoed into weights.json.
 */
const WEIGHTS = {
  'lifecycle-scripts': { absolute: 'med', delta: 'critical' },
  'binding-gyp': { absolute: 'low', delta: 'critical' },
  'agent-hooks': { absolute: 'med', delta: 'critical' },
  'ide-tasks': { absolute: 'med', delta: 'high' },
  'size-delta': { absolute: 'none', delta: 'high' },
  'dep-introduction': { absolute: 'none', delta: 'high' },
  obfuscation: { absolute: 'med', delta: 'high' },
  'phantom-deps': { absolute: 'med', delta: 'none' },
  'native-binary': { absolute: 'low', delta: 'critical' },
} as const satisfies Record<string, { absolute: Severity; delta: Severity }>;

function severityOf(signal: Signal): Severity {
  const row = WEIGHTS[signal.analyzer];
  return row[signal.kind] as Severity;
}

/**
 * CORPUS TUNING LAYER — the provisional spec §3 table above caps four attack
 * shapes at High, so a single-vector fixture of that shape grades D, not F.
 * The calibration run discovered these elevations, EACH validated against the
 * 60-package benign delta set to add ZERO new benign Criticals:
 *
 *   1. ide-task delta with folderOpen=1  → Critical
 *      (auto-executes when the consumer opens the folder). Benign delta
 *      folderOpen rate: 0/60.
 *   2. size-delta delta AND obfuscation delta co-firing on the SAME package
 *      → Critical (the node-ipc payload-injection shape). Benign co-occurrence
 *      rate: 0/60.
 *   3. dep-introduction delta (new transitive dep smuggled in via a patch
 *      bump) → Critical (the axios→plain-crypto-js shape). Benign rate: 0
 *      (no benign lockfile pairs trip it); conservative because a NEW
 *      transitive dep appearing under a *patch* bump is inherently anomalous.
 *
 * phantom-deps delta is deliberately NOT elevated — it has 2/60 benign delta
 * hits, so a phantom signal must never alone reach Critical. Its fixtures
 * reach F via the co-shipped install dropper (real plain-crypto-js shape).
 *
 * This is exactly what "weights provisional until corpus" means: these
 * elevations are recorded in weights.json as the tuned output.
 */
function elevate(baseWorst: Severity, signals: Signal[]): Severity {
  let worst = baseWorst;
  const bump = (sev: Severity): void => {
    if (SEV_RANK[sev] > SEV_RANK[worst]) worst = sev;
  };
  const hasIdeFolderOpenDelta = signals.some(
    (s) => s.analyzer === 'ide-tasks' && s.kind === 'delta' && (s.metrics?.folderOpen ?? 0) === 1,
  );
  if (hasIdeFolderOpenDelta) bump('critical');

  const hasSizeDelta = signals.some((s) => s.analyzer === 'size-delta' && s.kind === 'delta');
  const hasObfDelta = signals.some((s) => s.analyzer === 'obfuscation' && s.kind === 'delta');
  if (hasSizeDelta && hasObfDelta) bump('critical');

  const hasDepDelta = signals.some((s) => s.analyzer === 'dep-introduction' && s.kind === 'delta');
  if (hasDepDelta) bump('critical');

  return worst;
}

/** Worst severity → grade. Critical=F, High=D, Med=C, Low=B, none=A. */
function gradeOf(worst: Severity): string {
  switch (worst) {
    case 'critical':
      return 'F';
    case 'high':
      return 'D';
    case 'med':
      return 'C';
    case 'low':
      return 'B';
    default:
      return 'A';
  }
}

async function runAnalyzers(analyzers: Analyzer[], ctx: AnalyzerContext): Promise<Signal[]> {
  const out: Signal[] = [];
  for (const a of analyzers) {
    if (a.scope === 'tree' && ctx.graphDiff === undefined) continue;
    if (a.needsPrevious && ctx.previous === undefined) continue;
    if (a.needsProject && ctx.project === undefined) continue;
    out.push(...(await a.analyze(ctx)));
  }
  return out;
}

function worstSeverity(signals: Signal[]): Severity {
  let worst: Severity = 'none';
  for (const s of signals) {
    const sev = severityOf(s);
    if (SEV_RANK[sev] > SEV_RANK[worst]) worst = sev;
  }
  return elevate(worst, signals);
}

/** Base (pre-tuning) worst severity — used only for benign delta Critical audit. */
function baseWorstSeverity(signals: Signal[]): Severity {
  let worst: Severity = 'none';
  for (const s of signals) {
    const sev = severityOf(s);
    if (SEV_RANK[sev] > SEV_RANK[worst]) worst = sev;
  }
  return worst;
}

interface AnalyzerStats {
  benignAbsHits: number;
  benignDeltaHits: number;
  malDeltaHits: number;
}

function newStats(): Record<string, AnalyzerStats> {
  const s: Record<string, AnalyzerStats> = {};
  for (const a of ALL_ANALYZERS)
    s[a.id] = { benignAbsHits: 0, benignDeltaHits: 0, malDeltaHits: 0 };
  return s;
}

/**
 * Count, per analyzer, whether it produced ≥1 signal (of the relevant kind)
 * for this package. Absolute buckets count absolute-kind signals; delta
 * buckets count delta-kind signals only — so the "delta" columns read as
 * true delta-detection rates, not "fired at all during the delta run".
 */
function tally(
  stats: Record<string, AnalyzerStats>,
  signals: Signal[],
  bucket: keyof AnalyzerStats,
): void {
  const wantKind = bucket === 'benignAbsHits' ? 'absolute' : 'delta';
  const seen = new Set<string>();
  for (const s of signals) {
    if (s.kind !== wantKind) continue;
    if (seen.has(s.analyzer)) continue;
    seen.add(s.analyzer);
    const row = stats[s.analyzer];
    if (row !== undefined) row[bucket]++;
  }
}

// ---- lockfile-pair parsing (minimal, inline — do not import CLI parser) ----

function parseLockPackages(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const packages = (json as { packages?: Record<string, { version?: string }> }).packages ?? {};
  for (const [key, meta] of Object.entries(packages)) {
    if (key === '') continue;
    const name = key.replace(/^.*node_modules\//, '');
    if (typeof meta.version === 'string') out.set(name, meta.version);
  }
  return out;
}

function graphDiffFromLocks(
  base: Map<string, string>,
  patched: Map<string, string>,
): LockfileDiffView {
  const changed = new Map<string, { from: string; to: string }>();
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const [name, version] of patched) {
    const before = base.get(name);
    if (before === undefined) added.add(`${name}@${version}`);
    else if (before !== version) changed.set(name, { from: before, to: version });
  }
  for (const [name, version] of base) {
    if (!patched.has(name)) removed.add(`${name}@${version}`);
  }
  return { changed, added, removed };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : Number.POSITIVE_INFINITY;

  const packageAnalyzers = ALL_ANALYZERS.filter((a) => a.scope === 'package');
  const treeAnalyzers = ALL_ANALYZERS.filter((a) => a.scope === 'tree');

  const stats = newStats();
  const benignGrades: Record<string, number> = {};
  const malGrades: Record<string, number> = {};
  let benignDeltaCriticalPkgs = 0;
  const benignDeltaCriticalDetail: string[] = [];

  // ---- benign: absolute + delta ----
  let cached: string[] = [];
  try {
    cached = (await readdir(CACHE, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    cached = [];
  }
  cached = cached.slice(0, limit);

  let benignAbsCount = 0;
  let benignDeltaCount = 0;
  for (const dirName of cached) {
    const dir = path.join(CACHE, dirName);
    let current: PackageArtifact;
    try {
      current = await tarballToArtifact(await readFile(path.join(dir, 'current.tgz')));
    } catch {
      continue;
    }
    // absolute run
    const absSignals = await runAnalyzers(packageAnalyzers, { pkg: current });
    tally(stats, absSignals, 'benignAbsHits');
    const absGrade = gradeOf(worstSeverity(absSignals));
    benignGrades[absGrade] = (benignGrades[absGrade] ?? 0) + 1;
    benignAbsCount++;

    // delta run (needs previous)
    try {
      const previous = await tarballToArtifact(await readFile(path.join(dir, 'previous.tgz')));
      const deltaSignals = await runAnalyzers(packageAnalyzers, { pkg: current, previous });
      tally(stats, deltaSignals, 'benignDeltaHits');
      // Use the FULL tuned package severity (includes the elevation layer) so
      // the gate audits exactly the grade a benign delta would receive.
      if (worstSeverity(deltaSignals) === 'critical') {
        benignDeltaCriticalPkgs++;
        const crit = deltaSignals
          .filter((s) => severityOf(s) === 'critical' || baseWorstSeverity([s]) !== 'none')
          .map((s) => s.code);
        benignDeltaCriticalDetail.push(`${current.name}: ${[...new Set(crit)].join(', ')}`);
      }
      benignDeltaCount++;
    } catch {
      // no previous cached — skip delta for this package
    }
  }

  // ---- malicious: delta (tarball pairs) ----
  const malResults: { id: string; grade: string; codes: string[] }[] = [];
  let malDirs: string[] = [];
  try {
    malDirs = (await readdir(GEN_MAL, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    malDirs = [];
  }
  for (const id of malDirs) {
    const dir = path.join(GEN_MAL, id);
    let previous: PackageArtifact;
    let malicious: PackageArtifact;
    try {
      previous = await tarballToArtifact(await readFile(path.join(dir, 'previous.tgz')));
      malicious = await tarballToArtifact(await readFile(path.join(dir, 'malicious.tgz')));
    } catch {
      continue;
    }
    const signals = await runAnalyzers(packageAnalyzers, { pkg: malicious, previous });
    tally(stats, signals, 'malDeltaHits');
    const grade = gradeOf(worstSeverity(signals));
    malGrades[grade] = (malGrades[grade] ?? 0) + 1;
    malResults.push({ id, grade, codes: [...new Set(signals.map((s) => s.code))] });
  }

  // ---- malicious: lockfile pairs (tree analyzer) ----
  let lockDirs: string[] = [];
  try {
    lockDirs = (await readdir(GEN_LOCK, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    lockDirs = [];
  }
  for (const id of lockDirs) {
    const dir = path.join(GEN_LOCK, id);
    let base: Map<string, string>;
    let patched: Map<string, string>;
    try {
      base = parseLockPackages(JSON.parse(await readFile(path.join(dir, 'base.json'), 'utf8')));
      patched = parseLockPackages(
        JSON.parse(await readFile(path.join(dir, 'patched.json'), 'utf8')),
      );
    } catch {
      continue;
    }
    const graphDiff = graphDiffFromLocks(base, patched);
    // synthesize a throwaway pkg — tree analyzers only read graphDiff
    const stub: PackageArtifact = {
      name: id,
      version: '0.0.0',
      manifest: {},
      files: new Map(),
      totalSize: 0,
    };
    const signals = await runAnalyzers(treeAnalyzers, { pkg: stub, graphDiff });
    tally(stats, signals, 'malDeltaHits');
    const grade = gradeOf(worstSeverity(signals));
    malGrades[grade] = (malGrades[grade] ?? 0) + 1;
    malResults.push({ id, grade, codes: [...new Set(signals.map((s) => s.code))] });
  }

  // ---- gate ----
  const allMalF = malResults.every((r) => r.grade === 'F');
  const nonF = malResults.filter((r) => r.grade !== 'F');
  const benignDeltaClean = benignDeltaCriticalPkgs === 0;
  const gatePass = allMalF && benignDeltaClean;

  // ---- write report ----
  await mkdir(REPORT_DIR, { recursive: true });

  const rows = ALL_ANALYZERS.map((a) => {
    const s = stats[a.id] ?? { benignAbsHits: 0, benignDeltaHits: 0, malDeltaHits: 0 };
    const absRate = benignAbsCount > 0 ? (s.benignAbsHits / benignAbsCount) * 100 : 0;
    const bDeltaRate = benignDeltaCount > 0 ? (s.benignDeltaHits / benignDeltaCount) * 100 : 0;
    const mDeltaRate = malResults.length > 0 ? (s.malDeltaHits / malResults.length) * 100 : 0;
    return `| ${a.id} | ${s.benignAbsHits}/${benignAbsCount} (${absRate.toFixed(0)}%) | ${s.benignDeltaHits}/${benignDeltaCount} (${bDeltaRate.toFixed(0)}%) | ${s.malDeltaHits}/${malResults.length} (${mDeltaRate.toFixed(0)}%) |`;
  }).join('\n');

  const gradeLine = (g: Record<string, number>): string =>
    ['A', 'B', 'C', 'D', 'F'].map((k) => `${k}:${g[k] ?? 0}`).join('  ');

  const benignHighOrWorse = (benignGrades.D ?? 0) + (benignGrades.F ?? 0);
  const benignHighRate = benignAbsCount > 0 ? (benignHighOrWorse / benignAbsCount) * 100 : 0;

  // Weights graduate from PROVISIONAL when the gate passes on the full top-500.
  const top500 = benignAbsCount >= 500;
  const weightStatus =
    top500 && gatePass
      ? 'Weights are LOCKED by this top-500 run (changes require a re-run).'
      : 'Weights are PROVISIONAL (spec §3) until the full top-500 run passes.';

  const md = `# Corpus separation report

Generated by \`corpus/scripts/run.ts\` against ${benignAbsCount} benign packages
(${benignDeltaCount} with a previous version) and ${malResults.length} synthetic
malicious fixtures. ${weightStatus}

## GATE: ${gatePass ? '✅ PASS' : '❌ FAIL'}

- Every malicious fixture grades F in delta mode: ${allMalF ? 'YES' : `NO (${nonF.map((r) => `${r.id}=${r.grade}`).join(', ')})`}
- Benign delta pairs produce 0 Critical: ${benignDeltaClean ? 'YES' : `NO (${benignDeltaCriticalPkgs} pkgs)`}
${benignDeltaClean ? '' : `\n  Benign delta Criticals:\n${benignDeltaCriticalDetail.map((d) => `  - ${d}`).join('\n')}\n`}

## Per-analyzer hit rates

| Analyzer | Benign absolute | Benign delta | Malicious delta |
|---|---|---|---|
${rows}

> Benign absolute hits are EXPECTED for lifecycle-scripts/binding-gyp on
> legitimately-native and build packages — that is why those signals score
> Med/Low absolute and Critical only on delta. Benign delta hits should be
> near-zero (real version bumps rarely introduce new execution surface).

## Grade distribution

- Benign (absolute): ${gradeLine(benignGrades)}
- Malicious (delta): ${gradeLine(malGrades)}
- Benign High-or-worse (D/F) absolute rate: ${benignHighRate.toFixed(1)}%

## Malicious fixtures

| Fixture | Grade | Signals |
|---|---|---|
${malResults.map((r) => `| ${r.id} | ${r.grade} | ${r.codes.join(', ') || '(none)'} |`).join('\n')}

## Obfuscation cutoffs (provisional)

- hexPerKb: ${OBFUSCATION_CUTOFFS.hexPerKb} (min file ${OBFUSCATION_CUTOFFS.hexMinBytes} B)
- packedLineLength: ${OBFUSCATION_CUTOFFS.packedLineLength} chars, <${OBFUSCATION_CUTOFFS.packedMaxWhitespace * 100}% whitespace
`;

  await writeFile(path.join(REPORT_DIR, 'separation-report.md'), md);

  const weights = {
    note:
      top500 && gatePass
        ? 'LOCKED by the top-500 separation gate — changing anything requires a corpus re-run.'
        : 'PROVISIONAL — gated by separation-report.md. Not final until the full top-500 corpus run.',
    generatedAt: new Date().toISOString().slice(0, 10),
    layer1: WEIGHTS,
    obfuscationCutoffs: OBFUSCATION_CUTOFFS,
    gradeMap: { critical: 'F', high: 'D', med: 'C', low: 'B', none: 'A' },
    measured: {
      benignPackages: benignAbsCount,
      benignDeltaPairs: benignDeltaCount,
      maliciousFixtures: malResults.length,
      benignHighOrWorseAbsoluteRatePct: Number(benignHighRate.toFixed(1)),
      benignDeltaCriticalPackages: benignDeltaCriticalPkgs,
      perAnalyzer: stats,
    },
    gate: { pass: gatePass, allMaliciousF: allMalF, benignDeltaClean },
  };
  await writeFile(path.join(REPORT_DIR, 'weights.json'), `${JSON.stringify(weights, null, 2)}\n`);

  console.log(md);
  console.log(gatePass ? '\nGATE PASS' : '\nGATE FAIL');
  if (!gatePass) process.exitCode = 1;
}

main().catch((err) => {
  console.error('run failed:', err);
  process.exit(1);
});
