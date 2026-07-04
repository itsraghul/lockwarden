import { ExecError } from '../exit.js';
import type { AuditReport } from './types.ts';
import { SEV_RANK, type Severity } from './weights.ts';

const THRESHOLDS: Record<string, Severity> = {
  low: 'low',
  med: 'med',
  medium: 'med',
  high: 'high',
  critical: 'critical',
  b: 'low',
  c: 'med',
  d: 'high',
  f: 'critical',
};

/**
 * Parse a --threshold value: a severity name (low|med|medium|high|critical)
 * or a grade letter (B|C|D|F), case-insensitive. 'A' is not a threshold —
 * grade A means zero findings, which is what exit code 0 already expresses.
 */
export function parseThreshold(raw: string): Severity {
  const key = raw.trim().toLowerCase();
  if (key === 'a') {
    throw new ExecError(
      `invalid --threshold '${raw}': grade A means zero findings`,
      'The lowest usable threshold is B (low); a clean tree already exits 0.',
    );
  }
  const severity = THRESHOLDS[key];
  if (severity === undefined) {
    throw new ExecError(
      `invalid --threshold '${raw}'`,
      'Use a severity (low|med|medium|high|critical) or a grade letter (B|C|D|F).',
    );
  }
  return severity;
}

/** True when any finding in the report is at or above the threshold severity. */
export function exceedsThreshold(report: AuditReport, threshold: Severity): boolean {
  const floor = SEV_RANK[threshold];
  return report.packages.some((pkg) =>
    pkg.findings.some((finding) => SEV_RANK[finding.severity] >= floor),
  );
}
