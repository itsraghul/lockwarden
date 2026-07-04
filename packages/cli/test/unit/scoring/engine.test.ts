import { describe, expect, it } from 'vitest';
import { buildRollup, scorePackage, severityFor } from '../../../src/scoring/engine.js';
import type { PackageReport } from '../../../src/scoring/types.js';
import { PKG, l2, sig } from './helpers.js';

describe('severityFor', () => {
  it('maps absolute vs delta weights per analyzer', () => {
    expect(severityFor(sig('lifecycle-scripts', 'absolute'))).toBe('med');
    expect(severityFor(sig('lifecycle-scripts', 'delta'))).toBe('critical');
    expect(severityFor(sig('binding-gyp', 'absolute'))).toBe('low');
    expect(severityFor(sig('binding-gyp', 'delta'))).toBe('critical');
    expect(severityFor(sig('agent-hooks', 'delta'))).toBe('critical');
    expect(severityFor(sig('ide-tasks', 'absolute'))).toBe('med');
    expect(severityFor(sig('ide-tasks', 'delta'))).toBe('high');
    expect(severityFor(sig('dep-introduction', 'delta'))).toBe('critical');
    expect(severityFor(sig('obfuscation', 'delta'))).toBe('high');
  });

  it("returns 'none' where the mode carries no weight", () => {
    expect(severityFor(sig('size-delta', 'absolute'))).toBe('none');
    expect(severityFor(sig('phantom-deps', 'delta'))).toBe('none');
    expect(severityFor(sig('dep-introduction', 'absolute'))).toBe('none');
  });
});

describe('scorePackage', () => {
  it('grades A with no signals and no layer-2 hits', () => {
    const report = scorePackage(PKG, [], []);
    expect(report.grade).toBe('A');
    expect(report.findings).toEqual([]);
    expect(report.key).toBe('left-pad@1.3.0');
  });

  it("excludes 'none'-weight signals from findings entirely", () => {
    const report = scorePackage(
      PKG,
      [sig('size-delta', 'absolute'), sig('phantom-deps', 'delta')],
      [],
    );
    expect(report.findings).toEqual([]);
    expect(report.grade).toBe('A');
  });

  it('maps grade boundaries per worst severity', () => {
    expect(scorePackage(PKG, [sig('binding-gyp', 'absolute')], []).grade).toBe('B'); // low
    expect(scorePackage(PKG, [sig('lifecycle-scripts', 'absolute')], []).grade).toBe('C'); // med
    expect(scorePackage(PKG, [sig('ide-tasks', 'delta')], []).grade).toBe('D'); // high
    expect(scorePackage(PKG, [sig('lifecycle-scripts', 'delta')], []).grade).toBe('F'); // critical
  });

  it('sorts findings severity-descending', () => {
    const report = scorePackage(
      PKG,
      [
        sig('binding-gyp', 'absolute'),
        sig('lifecycle-scripts', 'delta'),
        sig('obfuscation', 'absolute'),
      ],
      [],
    );
    expect(report.findings.map((f) => f.severity)).toEqual(['critical', 'med', 'low']);
  });

  describe('corpus elevation layer', () => {
    it('ide-tasks delta with folderOpen elevates to F (Shai-Hulud shape)', () => {
      const report = scorePackage(
        PKG,
        [sig('ide-tasks', 'delta', { metrics: { folderOpen: 1 } })],
        [],
      );
      expect(report.grade).toBe('F');
      // the finding itself keeps its base weight; only the grade is elevated
      expect(report.findings.map((f) => f.severity)).toEqual(['high']);
    });

    it('ide-tasks delta without folderOpen stays D', () => {
      const report = scorePackage(
        PKG,
        [sig('ide-tasks', 'delta', { metrics: { folderOpen: 0 } })],
        [],
      );
      expect(report.grade).toBe('D');
    });

    it('size-delta + obfuscation co-delta elevates to F (node-ipc shape)', () => {
      const report = scorePackage(
        PKG,
        [sig('size-delta', 'delta'), sig('obfuscation', 'delta')],
        [],
      );
      expect(report.grade).toBe('F');
    });

    it('size-delta delta alone stays D', () => {
      expect(scorePackage(PKG, [sig('size-delta', 'delta')], []).grade).toBe('D');
    });

    it('obfuscation delta alone stays D', () => {
      expect(scorePackage(PKG, [sig('obfuscation', 'delta')], []).grade).toBe('D');
    });
  });

  it('any layer-2 hit forces F over a clean layer 1', () => {
    const report = scorePackage(PKG, [], [l2()]);
    expect(report.grade).toBe('F');
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.layer).toBe(2);
    expect(report.findings[0]?.severity).toBe('critical');
  });

  it('layer-2 forces F even when layer 1 only sees low', () => {
    const report = scorePackage(PKG, [sig('binding-gyp', 'absolute')], [l2()]);
    expect(report.grade).toBe('F');
    expect(report.findings.map((f) => f.severity)).toEqual(['critical', 'low']);
  });
});

describe('buildRollup', () => {
  const reportOf = (signals: Parameters<typeof scorePackage>[1]): PackageReport =>
    scorePackage(PKG, signals, []);

  it('returns grade A for an empty report set', () => {
    const rollup = buildRollup([], 42);
    expect(rollup).toEqual({
      grade: 'A',
      packagesAnalyzed: 42,
      packagesFlagged: 0,
      counts: { none: 0, low: 0, med: 0, high: 0, critical: 0 },
    });
  });

  it('takes the worst grade and counts findings per severity', () => {
    const rollup = buildRollup(
      [
        reportOf([sig('binding-gyp', 'absolute')]), // B, 1 low
        reportOf([sig('lifecycle-scripts', 'delta'), sig('obfuscation', 'absolute')]), // F, 1 critical + 1 med
        reportOf([sig('ide-tasks', 'delta')]), // D, 1 high
        reportOf([]), // A, unflagged
      ],
      100,
    );
    expect(rollup.grade).toBe('F');
    expect(rollup.packagesAnalyzed).toBe(100);
    expect(rollup.packagesFlagged).toBe(3);
    expect(rollup.counts).toEqual({ none: 0, low: 1, med: 1, high: 1, critical: 1 });
  });

  it('reflects elevation-only F grades even when no finding is critical', () => {
    const elevated = reportOf([sig('size-delta', 'delta'), sig('obfuscation', 'delta')]);
    const rollup = buildRollup([elevated], 1);
    expect(rollup.grade).toBe('F');
    expect(rollup.counts.critical).toBe(0);
    expect(rollup.counts.high).toBe(2);
  });
});
