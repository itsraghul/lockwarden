import type { Signal } from '../analyzers/types.ts';
import type { Grade, Severity } from './weights.ts';

/** A signal with its corpus-gated severity attached. Layer 2 hits are always critical. */
export interface Finding {
  signal: Signal;
  severity: Severity;
  layer: 1 | 2;
}

export interface PackageReport {
  name: string;
  version: string;
  key: string; // "name@version"
  grade: Grade;
  findings: Finding[];
}

export interface Rollup {
  grade: Grade; // worst package grade
  packagesAnalyzed: number;
  packagesFlagged: number;
  counts: Record<Severity, number>;
}

export interface AuditReport {
  command: 'audit';
  mode: 'absolute' | 'diff' | 'deep';
  lockfile: { path: string; type: string };
  packages: PackageReport[]; // only packages with ≥1 finding
  rollup: Rollup;
  warnings: string[];
}
