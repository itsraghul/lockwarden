/**
 * Layer-1 scoring engine: maps analyzer signals (facts) to findings via the
 * corpus-generated weights, applies the corpus elevation layer, and lets any
 * Layer-2 hit force critical. Analyzers never see severities; this is the
 * only place (analyzer, kind) → weight happens.
 */
import type { Signal } from '../analyzers/types.ts';
import type { Finding, Layer1Finding, PackageReport, Rollup } from './types.ts';
import {
  GRADE_OF_SEVERITY,
  type Grade,
  SEV_RANK,
  type Severity,
  WEIGHTS,
  elevateSeverity,
} from './weights.ts';

/** The corpus-gated severity for one signal: WEIGHTS[analyzer][kind]. */
export function severityFor(signal: Signal): Severity {
  return WEIGHTS[signal.analyzer][signal.kind];
}

/**
 * Score one package. A 'none' weight means the signal carries no severity in
 * this mode (e.g. size-delta absolute, phantom-deps delta) — such signals are
 * excluded from findings entirely, but still feed the elevation layer.
 */
export function scorePackage(
  pkg: { name: string; version: string },
  signals: Signal[],
  layer2: Finding[],
): PackageReport {
  const layer1: Layer1Finding[] = [];
  for (const signal of signals) {
    const severity = severityFor(signal);
    if (severity === 'none') continue;
    layer1.push({ layer: 1, signal, severity });
  }

  let worst: Severity = 'none';
  for (const finding of layer1) {
    if (SEV_RANK[finding.severity] > SEV_RANK[worst]) worst = finding.severity;
  }
  worst = elevateSeverity(worst, signals);
  if (layer2.length > 0) worst = 'critical';

  const findings: Finding[] = [...layer1, ...layer2].sort(
    (a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity],
  );

  return {
    name: pkg.name,
    version: pkg.version,
    key: `${pkg.name}@${pkg.version}`,
    grade: GRADE_OF_SEVERITY[worst],
    findings,
  };
}

const GRADE_RANK: Record<Grade, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };

/** Project rollup: worst package grade (A if none flagged) + severity counts. */
export function buildRollup(reports: PackageReport[], packagesAnalyzed: number): Rollup {
  const counts: Record<Severity, number> = { none: 0, low: 0, med: 0, high: 0, critical: 0 };
  let grade: Grade = 'A';
  let packagesFlagged = 0;

  for (const report of reports) {
    if (report.findings.length > 0) packagesFlagged += 1;
    if (GRADE_RANK[report.grade] > GRADE_RANK[grade]) grade = report.grade;
    for (const finding of report.findings) counts[finding.severity] += 1;
  }

  return { grade, packagesAnalyzed, packagesFlagged, counts };
}
