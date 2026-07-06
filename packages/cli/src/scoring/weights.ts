/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ GENERATED FROM THE CORPUS RUN — do not hand-edit.                       │
 * │ Source: corpus/report/weights.json @ TOP-500 corpus run 2026-07-06      │
 * │ (500 benign / 496 real version-bump pairs + 22 synthetic malicious,     │
 * │ separation gate PASS: 0 benign delta Criticals, all malicious F).       │
 * │ Weights are LOCKED by that gate — no longer provisional.                │
 * │ To change anything here: change the analyzers or corpus, re-run         │
 * │ `pnpm corpus:run`, and transcribe the new weights.json.                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
import type { AnalyzerId, Signal } from '../analyzers/types.ts';

export type Severity = 'none' | 'low' | 'med' | 'high' | 'critical';

export const SEV_RANK: Record<Severity, number> = {
  none: 0,
  low: 1,
  med: 2,
  high: 3,
  critical: 4,
};

export const WEIGHTS: Record<AnalyzerId, { absolute: Severity; delta: Severity }> = {
  'lifecycle-scripts': { absolute: 'med', delta: 'critical' },
  'binding-gyp': { absolute: 'low', delta: 'critical' },
  'agent-hooks': { absolute: 'med', delta: 'critical' },
  'ide-tasks': { absolute: 'med', delta: 'high' },
  'size-delta': { absolute: 'none', delta: 'high' },
  'dep-introduction': { absolute: 'none', delta: 'critical' },
  obfuscation: { absolute: 'med', delta: 'high' },
  'phantom-deps': { absolute: 'med', delta: 'none' },
  'native-binary': { absolute: 'low', delta: 'critical' },
};

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export const GRADE_OF_SEVERITY: Record<Severity, Grade> = {
  critical: 'F',
  high: 'D',
  med: 'C',
  low: 'B',
  none: 'A',
};

/**
 * Corpus-tuned elevation layer (weights.json "elevations"): three delta shapes
 * where the spec-§3 base weight of High understates a validated attack shape.
 * Each was verified to add ZERO benign Criticals on the calibration set.
 * NOTE: dep-introduction delta is encoded directly as critical in WEIGHTS
 * above; the two compound shapes below need signal context.
 */
export function elevateSeverity(base: Severity, signals: Signal[]): Severity {
  let worst = base;
  const bump = (sev: Severity): void => {
    if (SEV_RANK[sev] > SEV_RANK[worst]) worst = sev;
  };

  // ide-task delta that auto-executes on folder open (Shai-Hulud shape)
  if (
    signals.some(
      (s) => s.analyzer === 'ide-tasks' && s.kind === 'delta' && (s.metrics?.folderOpen ?? 0) === 1,
    )
  ) {
    bump('critical');
  }

  // main-file inflation AND new obfuscation in the same version (node-ipc shape)
  const sizeDelta = signals.some((s) => s.analyzer === 'size-delta' && s.kind === 'delta');
  const obfDelta = signals.some((s) => s.analyzer === 'obfuscation' && s.kind === 'delta');
  if (sizeDelta && obfDelta) bump('critical');

  return worst;
}
