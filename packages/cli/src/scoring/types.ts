import type { Signal } from '../analyzers/types.ts';
import type { Grade, Severity } from './weights.ts';

/** Provenance of a Layer-2 (known-bad overlay) hit. */
export interface Layer2Ref {
  source: 'osv' | 'incident';
  /** OSV id (MAL-2026-XXXX) or incident bundle id (node-ipc-may26). */
  id: string;
  summary: string;
}

/** A structural signal with its corpus-gated severity attached (Layer 1). */
export interface Layer1Finding {
  layer: 1;
  signal: Signal;
  severity: Severity;
}

/** A known-bad overlay hit (Layer 2) — always critical, regardless of Layer 1. */
export interface Layer2Finding {
  layer: 2;
  severity: 'critical';
  /** Stable rule id: `LW2-OSV-<id>` or `LW2-IOC-<id>`. */
  code: string;
  package: { name: string; version: string };
  layer2: Layer2Ref;
}

/** A signal with its corpus-gated severity attached. Layer 2 hits are always critical. */
export type Finding = Layer1Finding | Layer2Finding;

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
