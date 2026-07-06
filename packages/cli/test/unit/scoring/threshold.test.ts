import { describe, expect, it } from 'vitest';
import { ExecError } from '../../../src/exit.js';
import { scorePackage } from '../../../src/scoring/engine.js';
import { exceedsThreshold, parseThreshold } from '../../../src/scoring/threshold.js';
import type { AuditReport, PackageReport } from '../../../src/scoring/types.js';
import { PKG, sig } from './helpers.js';

describe('parseThreshold', () => {
  it('accepts severity names', () => {
    expect(parseThreshold('low')).toBe('low');
    expect(parseThreshold('med')).toBe('med');
    expect(parseThreshold('high')).toBe('high');
    expect(parseThreshold('critical')).toBe('critical');
  });

  it("accepts the 'medium' alias", () => {
    expect(parseThreshold('medium')).toBe('med');
  });

  it('accepts grade letters, case-insensitive', () => {
    expect(parseThreshold('B')).toBe('low');
    expect(parseThreshold('c')).toBe('med');
    expect(parseThreshold('D')).toBe('high');
    expect(parseThreshold('f')).toBe('critical');
    expect(parseThreshold('CRITICAL')).toBe('critical');
    expect(parseThreshold('  High ')).toBe('high');
  });

  it("rejects 'A' with an ExecError", () => {
    expect(() => parseThreshold('A')).toThrow(ExecError);
    expect(() => parseThreshold('a')).toThrow(ExecError);
  });

  it('rejects unknown values with an ExecError', () => {
    expect(() => parseThreshold('severe')).toThrow(ExecError);
    expect(() => parseThreshold('')).toThrow(ExecError);
    expect(() => parseThreshold('none')).toThrow(ExecError);
  });
});

function auditReport(packages: PackageReport[]): AuditReport {
  return {
    command: 'audit',
    mode: 'absolute',
    lockfile: { path: 'package-lock.json', type: 'npm' },
    packages,
    rollup: {
      grade: 'A',
      packagesAnalyzed: packages.length,
      packagesFlagged: packages.length,
      counts: { none: 0, low: 0, med: 0, high: 0, critical: 0 },
    },
    warnings: [],
    advisories: { osvGeneratedAt: '2026-07-03', newestIncident: '2026-06-09' },
  };
}

describe('exceedsThreshold', () => {
  const highReport = auditReport([scorePackage(PKG, [sig('ide-tasks', 'delta')], [])]); // one high

  it('is false for an empty report', () => {
    expect(exceedsThreshold(auditReport([]), 'low')).toBe(false);
  });

  it('finding severity equal to the threshold exceeds it (at/above)', () => {
    expect(exceedsThreshold(highReport, 'high')).toBe(true);
  });

  it('finding below the threshold does not exceed it', () => {
    expect(exceedsThreshold(highReport, 'critical')).toBe(false);
  });

  it('finding above the threshold exceeds it', () => {
    expect(exceedsThreshold(highReport, 'low')).toBe(true);
    expect(exceedsThreshold(highReport, 'med')).toBe(true);
  });

  it('scans across all packages', () => {
    const mixed = auditReport([
      scorePackage({ name: 'a', version: '1.0.0' }, [sig('binding-gyp', 'absolute')], []), // low
      scorePackage({ name: 'b', version: '2.0.0' }, [sig('lifecycle-scripts', 'delta')], []), // critical
    ]);
    expect(exceedsThreshold(mixed, 'critical')).toBe(true);
  });
});
