import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildRollup, scorePackage } from '../../../src/scoring/engine.js';
import { toSarif } from '../../../src/scoring/sarif.js';
import type { AuditReport } from '../../../src/scoring/types.js';
import { l2, sig } from './helpers.js';

/** Minimal typed view of the SARIF document for assertions. */
interface SarifDoc {
  $schema: string;
  version: string;
  runs: Array<{
    tool: {
      driver: {
        name: string;
        informationUri: string;
        version: string;
        rules: Array<{ id: string; helpUri: string }>;
      };
    };
    results: Array<{
      ruleId: string;
      ruleIndex: number;
      level: string;
      message: { text: string };
      locations: Array<{
        physicalLocation: { artifactLocation: { uri: string } };
        logicalLocations: Array<{ fullyQualifiedName: string }>;
      }>;
      partialFingerprints: Record<string, string>;
    }>;
  }>;
}

function fixtureReport(): AuditReport {
  const evil = scorePackage(
    { name: 'evil-pkg', version: '6.6.6' },
    [
      sig('lifecycle-scripts', 'delta', {
        code: 'LW001D-LIFECYCLE-INTRODUCED',
        detail: 'postinstall script introduced in 6.6.6 (absent in 6.6.5)',
      }),
      sig('ide-tasks', 'delta', {
        code: 'LW004D-IDE-TASK-INTRODUCED',
        detail: '.vscode/tasks.json appeared in 6.6.6',
      }),
      sig('obfuscation', 'absolute', {
        code: 'LW007-OBFUSCATION-MARKERS',
        detail: 'hex-encoded string table in lib/index.js',
      }),
    ],
    [
      l2(
        { name: 'evil-pkg', version: '6.6.6' },
        { id: 'MAL-2026-9999', summary: 'known-bad seed' },
      ),
    ],
  );
  const meh = scorePackage(
    { name: 'meh-pkg', version: '2.0.0' },
    [
      sig('binding-gyp', 'absolute', {
        code: 'LW002-BINDING-GYP-PRESENT',
        detail: 'binding.gyp present (legitimate native build is common)',
      }),
    ],
    [],
  );
  const packages = [evil, meh];
  return {
    command: 'audit',
    mode: 'diff',
    lockfile: { path: 'package-lock.json', type: 'npm' },
    packages,
    rollup: buildRollup(packages, 250),
    warnings: [],
  };
}

const doc = (verbose?: boolean): SarifDoc =>
  toSarif(fixtureReport(), { toolVersion: '1.2.3', verbose }) as SarifDoc;

describe('toSarif', () => {
  it('produces a stable SARIF 2.1.0 document (snapshot)', () => {
    expect(doc()).toMatchSnapshot();
  });

  it('sets tool driver metadata and defaults version to 0.0.0', () => {
    const d = doc();
    expect(d.version).toBe('2.1.0');
    expect(d.runs).toHaveLength(1);
    const driver = d.runs[0]?.tool.driver;
    expect(driver?.name).toBe('lockwarden');
    expect(driver?.informationUri).toBe('https://github.com/itsraghul/lockwarden');
    expect(driver?.version).toBe('1.2.3');

    const defaulted = toSarif(fixtureReport(), {}) as SarifDoc;
    expect(defaulted.runs[0]?.tool.driver.version).toBe('0.0.0');
  });

  it('maps severities to SARIF levels', () => {
    const results = doc().runs[0]?.results ?? [];
    const levelOf = (ruleId: string): string | undefined =>
      results.find((r) => r.ruleId === ruleId)?.level;
    expect(levelOf('LW001D-LIFECYCLE-INTRODUCED')).toBe('error'); // critical
    expect(levelOf('LW2-OSV-MAL-2026-9999')).toBe('error'); // layer-2 critical
    expect(levelOf('LW004D-IDE-TASK-INTRODUCED')).toBe('warning'); // high
    expect(levelOf('LW007-OBFUSCATION-MARKERS')).toBe('note'); // med
  });

  it('omits low findings by default and includes them with verbose', () => {
    const byDefault = doc().runs[0]?.results ?? [];
    expect(byDefault.some((r) => r.ruleId === 'LW002-BINDING-GYP-PRESENT')).toBe(false);

    const verbose = doc(true).runs[0]?.results ?? [];
    const low = verbose.find((r) => r.ruleId === 'LW002-BINDING-GYP-PRESENT');
    expect(low?.level).toBe('note');
    expect(verbose.length).toBe(byDefault.length + 1);
  });

  it('declares one rule per distinct code, referenced by ruleIndex', () => {
    const run = doc(true).runs[0];
    const ruleIds = (run?.tool.driver.rules ?? []).map((r) => r.id);
    expect(new Set(ruleIds).size).toBe(ruleIds.length);
    expect(ruleIds).toContain('LW2-OSV-MAL-2026-9999');
    for (const rule of run?.tool.driver.rules ?? []) {
      expect(rule.helpUri).toBe('https://github.com/itsraghul/lockwarden#readme');
    }
    for (const result of run?.results ?? []) {
      expect(ruleIds[result.ruleIndex]).toBe(result.ruleId);
    }
  });

  it('locates results at the lockfile path with the package as logical location', () => {
    const result = (doc().runs[0]?.results ?? []).find(
      (r) => r.ruleId === 'LW001D-LIFECYCLE-INTRODUCED',
    );
    const location = result?.locations[0];
    expect(location?.physicalLocation.artifactLocation.uri).toBe('package-lock.json');
    expect(location?.logicalLocations[0]?.fullyQualifiedName).toBe('evil-pkg@6.6.6');
    expect(result?.message.text).toContain('evil-pkg@6.6.6');
    expect(result?.message.text).toContain('postinstall script introduced');
  });

  it('emits stable sha256 partialFingerprints (same input -> same fingerprint)', () => {
    const first = doc().runs[0]?.results ?? [];
    const second = doc().runs[0]?.results ?? [];
    expect(first.map((r) => r.partialFingerprints)).toEqual(
      second.map((r) => r.partialFingerprints),
    );
    const fp = first.find((r) => r.ruleId === 'LW001D-LIFECYCLE-INTRODUCED')?.partialFingerprints[
      'lockwarden/v1'
    ];
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
    expect(fp).toBe(
      createHash('sha256').update('LW001D-LIFECYCLE-INTRODUCED:evil-pkg@6.6.6').digest('hex'),
    );
  });

  it("never emits 'none' — an empty report yields zero results and rules", () => {
    const empty: AuditReport = {
      command: 'audit',
      mode: 'absolute',
      lockfile: { path: 'pnpm-lock.yaml', type: 'pnpm' },
      packages: [],
      rollup: buildRollup([], 10),
      warnings: [],
    };
    const d = toSarif(empty, { toolVersion: '1.2.3' }) as SarifDoc;
    expect(d.runs[0]?.results).toEqual([]);
    expect(d.runs[0]?.tool.driver.rules).toEqual([]);
  });
});
