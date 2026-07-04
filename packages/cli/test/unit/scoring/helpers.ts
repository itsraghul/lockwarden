import type { AnalyzerId, Signal, SignalKind } from '../../../src/analyzers/types.js';
import type { Layer2Finding } from '../../../src/scoring/types.js';

export const PKG = { name: 'left-pad', version: '1.3.0' };

/** Build a minimal, valid Signal for scoring tests. */
export function sig(
  analyzer: AnalyzerId,
  kind: SignalKind,
  overrides: { code?: string; metrics?: Record<string, number>; detail?: string } = {},
): Signal {
  const signal: Signal = {
    analyzer,
    code: overrides.code ?? `${analyzer}-${kind}`.toUpperCase(),
    kind,
    package: { ...PKG },
    evidence: { detail: overrides.detail ?? `${analyzer} ${kind} signal` },
  };
  if (overrides.metrics) signal.metrics = overrides.metrics;
  return signal;
}

/** Build a synthetic Layer-2 finding (as layer2Findings would). */
export function l2(
  pkg: { name: string; version: string } = PKG,
  overrides: { source?: 'osv' | 'incident'; id?: string; summary?: string } = {},
): Layer2Finding {
  const source = overrides.source ?? 'osv';
  const id = overrides.id ?? 'MAL-2026-0000';
  return {
    layer: 2,
    severity: 'critical',
    code: source === 'osv' ? `LW2-OSV-${id}` : `LW2-IOC-${id}`,
    package: { ...pkg },
    layer2: { source, id, summary: overrides.summary ?? 'known-bad test entry' },
  };
}
