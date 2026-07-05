import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExecError } from '../../../src/exit.js';
import {
  type BaselineFile,
  applyBaseline,
  buildBaseline,
  loadBaseline,
} from '../../../src/scoring/baseline.js';
import { scorePackage } from '../../../src/scoring/engine.js';
import type { PackageReport } from '../../../src/scoring/types.js';
import { l2, sig } from './helpers.js';

const NOW = new Date('2026-07-05T12:00:00Z');

function baselineOf(entries: BaselineFile['entries']): BaselineFile {
  return { version: 1, entries };
}

/** grade C: one med absolute lifecycle finding — the canonical suppressible shape. */
function toolingPkg(version = '1.0.0'): PackageReport {
  return scorePackage(
    { name: 'toolpkg', version },
    [sig('lifecycle-scripts', 'absolute', { code: 'LW001-LIFECYCLE' })],
    [],
  );
}

/** grade F via a critical delta finding. */
function criticalPkg(): PackageReport {
  return scorePackage(
    { name: 'evil', version: '2.0.0' },
    [sig('lifecycle-scripts', 'delta', { code: 'LW001D-LIFECYCLE-INTRODUCED' })],
    [],
  );
}

/** grade F via corpus ELEVATION of two high delta findings (node-ipc shape). */
function elevatedPkg(): PackageReport {
  return scorePackage(
    { name: 'sneaky', version: '3.1.4' },
    [
      sig('size-delta', 'delta', { code: 'LW005D-SIZE-DELTA' }),
      sig('obfuscation', 'delta', { code: 'LW007D-OBFUSCATION-INTRODUCED' }),
    ],
    [],
  );
}

describe('loadBaseline', () => {
  async function tmpFile(content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'lockwarden-baseline-'));
    const path = join(dir, '.lockwarden-baseline.json');
    await writeFile(path, content, 'utf8');
    return path;
  }

  it('returns null when the file is absent', async () => {
    expect(await loadBaseline('/nonexistent/.lockwarden-baseline.json')).toBeNull();
  });

  it('throws ExecError on invalid JSON', async () => {
    await expect(loadBaseline(await tmpFile('{nope'))).rejects.toThrow(ExecError);
  });

  it('throws ExecError on an unsupported version', async () => {
    const path = await tmpFile(JSON.stringify({ version: 2, entries: [] }));
    await expect(loadBaseline(path)).rejects.toThrow(/unsupported "version"/);
  });

  it('throws ExecError on malformed entries', async () => {
    const missing = await tmpFile(JSON.stringify({ version: 1, entries: [{ code: 'LW001' }] }));
    await expect(loadBaseline(missing)).rejects.toThrow(/"package" must be/);
    const badType = await tmpFile(
      JSON.stringify({ version: 1, entries: [{ code: 'LW001', package: 'x', expires: 42 }] }),
    );
    await expect(loadBaseline(badType)).rejects.toThrow(/"expires" must be a string/);
  });

  it('ignores unknown fields (forward compatibility)', async () => {
    const path = await tmpFile(
      JSON.stringify({
        version: 1,
        entries: [{ code: 'LW001-LIFECYCLE', package: 'toolpkg', futureField: true }],
        futureTopLevel: {},
      }),
    );
    const loaded = await loadBaseline(path);
    expect(loaded?.entries).toEqual([{ code: 'LW001-LIFECYCLE', package: 'toolpkg' }]);
  });
});

describe('applyBaseline', () => {
  it('suppresses a matched finding and re-derives the grade', () => {
    const baseline = baselineOf([
      { code: 'LW001-LIFECYCLE', package: 'toolpkg', reason: 'reviewed' },
    ]);
    const applied = applyBaseline([toolingPkg()], baseline, NOW);
    const pkg = applied.reports[0];
    expect(pkg?.findings).toEqual([]);
    expect(pkg?.suppressed).toHaveLength(1);
    expect(pkg?.suppressed?.[0]?.suppression.reason).toBe('reviewed');
    expect(pkg?.grade).toBe('A');
    expect(applied.matched).toBe(1);
    expect(applied.suppressedCounts.med).toBe(1);
  });

  it('matches version-independently: one entry covers any version of the package', () => {
    const baseline = baselineOf([{ code: 'LW001-LIFECYCLE', package: 'toolpkg' }]);
    for (const version of ['1.0.0', '1.0.1', '9.9.9']) {
      const applied = applyBaseline([toolingPkg(version)], baseline, NOW);
      expect(applied.matched).toBe(1);
    }
  });

  it('never suppresses critical findings', () => {
    const baseline = baselineOf([{ code: 'LW001D-LIFECYCLE-INTRODUCED', package: 'evil' }]);
    const applied = applyBaseline([criticalPkg()], baseline, NOW);
    expect(applied.matched).toBe(0);
    expect(applied.reports[0]?.findings).toHaveLength(1);
    expect(applied.reports[0]?.grade).toBe('F');
    expect(applied.warnings.some((w) => w.includes('non-suppressible'))).toBe(true);
  });

  it('never suppresses Layer-2 findings', () => {
    const report = scorePackage(
      { name: 'owned', version: '1.0.0' },
      [],
      [l2({ name: 'owned', version: '1.0.0' }, { id: 'MAL-2026-0001' })],
    );
    const baseline = baselineOf([{ code: 'LW2-OSV-MAL-2026-0001', package: 'owned' }]);
    const applied = applyBaseline([report], baseline, NOW);
    expect(applied.matched).toBe(0);
    expect(applied.reports[0]?.grade).toBe('F');
  });

  it('locks delta findings on an elevated grade-F package (compound Critical)', () => {
    const baseline = baselineOf([
      { code: 'LW005D-SIZE-DELTA', package: 'sneaky' },
      { code: 'LW007D-OBFUSCATION-INTRODUCED', package: 'sneaky' },
    ]);
    const applied = applyBaseline([elevatedPkg()], baseline, NOW);
    expect(applied.matched).toBe(0);
    expect(applied.reports[0]?.findings).toHaveLength(2);
    expect(applied.reports[0]?.grade).toBe('F');
  });

  it('expired entries stop suppressing, warn, and are counted', () => {
    const baseline = baselineOf([
      { code: 'LW001-LIFECYCLE', package: 'toolpkg', expires: '2026-07-05' },
    ]);
    // On the expiry date (any time of day) the entry is already expired.
    const applied = applyBaseline([toolingPkg()], baseline, NOW);
    expect(applied.matched).toBe(0);
    expect(applied.expired).toBe(1);
    expect(applied.reports[0]?.findings).toHaveLength(1);
    expect(applied.warnings.some((w) => w.includes('expired'))).toBe(true);

    // The day before, it still suppresses.
    const before = applyBaseline([toolingPkg()], baseline, new Date('2026-07-04T23:59:59Z'));
    expect(before.matched).toBe(1);
    expect(before.expired).toBe(0);
  });

  it('leaves untouched packages identical and unmatched entries silent', () => {
    const baseline = baselineOf([{ code: 'LW999-NOPE', package: 'other' }]);
    const input = [toolingPkg()];
    const applied = applyBaseline(input, baseline, NOW);
    expect(applied.reports[0]).toBe(input[0]);
    expect(applied.matched).toBe(0);
    expect(applied.warnings).toEqual([]);
  });
});

describe('buildBaseline', () => {
  it('collects suppressible findings, skipping critical/Layer-2/elevated-delta', () => {
    const built = buildBaseline([toolingPkg(), criticalPkg(), elevatedPkg()], '9.9.9', NOW);
    expect(built.file.entries).toEqual([
      {
        code: 'LW001-LIFECYCLE',
        package: 'toolpkg',
        version: '1.0.0',
        addedAt: '2026-07-05',
      },
    ]);
    expect(built.skipped).toEqual([
      'LW001D-LIFECYCLE-INTRODUCED (evil@2.0.0)',
      'LW005D-SIZE-DELTA (sneaky@3.1.4)',
      'LW007D-OBFUSCATION-INTRODUCED (sneaky@3.1.4)',
    ]);
    expect(built.file.version).toBe(1);
    expect(built.file.tool).toBe('lockwarden@9.9.9');
    expect(built.file.generatedAt).toBe('2026-07-05');
  });

  it('preserves addedAt/reason/expires of surviving entries and prunes stale ones', () => {
    const previous = baselineOf([
      {
        code: 'LW001-LIFECYCLE',
        package: 'toolpkg',
        version: '0.9.0',
        addedAt: '2026-01-01',
        reason: 'kept',
        expires: '2027-01-01',
      },
      { code: 'LW002-BINDING-GYP', package: 'gone-pkg', addedAt: '2026-01-01' },
    ]);
    const built = buildBaseline([toolingPkg()], '9.9.9', NOW, previous);
    expect(built.file.entries).toEqual([
      {
        code: 'LW001-LIFECYCLE',
        package: 'toolpkg',
        version: '1.0.0',
        addedAt: '2026-01-01',
        reason: 'kept',
        expires: '2027-01-01',
      },
    ]);
    expect(built.pruned).toBe(1);
  });
});
