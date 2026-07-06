import { describe, expect, it } from 'vitest';
import type { Layer2Sources } from '../../../src/scoring/layer2.js';
import { layer2Findings, loadLayer2Sources } from '../../../src/scoring/layer2.js';

const EMPTY: Layer2Sources = { osv: [], incidents: [] };

function osvSources(entry: Partial<Layer2Sources['osv'][number]>): Layer2Sources {
  return {
    osv: [{ id: 'MAL-2026-9999', package: 'evil-pkg', summary: 'test entry', ...entry }],
    incidents: [],
  };
}

describe('layer2Findings — OSV matching', () => {
  it('matches an exact version', () => {
    const findings = layer2Findings(
      { name: 'evil-pkg', version: '1.2.3' },
      osvSources({ versions: ['1.2.3', '2.0.0'] }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      layer: 2,
      severity: 'critical',
      code: 'LW2-OSV-MAL-2026-9999',
      package: { name: 'evil-pkg', version: '1.2.3' },
      layer2: { source: 'osv', id: 'MAL-2026-9999', summary: 'test entry' },
    });
  });

  it('does not match a version outside the list', () => {
    const findings = layer2Findings(
      { name: 'evil-pkg', version: '1.2.4' },
      osvSources({ versions: ['1.2.3'] }),
    );
    expect(findings).toEqual([]);
  });

  it('does not match a different package name', () => {
    const findings = layer2Findings(
      { name: 'good-pkg', version: '1.2.3' },
      osvSources({ versions: ['1.2.3'] }),
    );
    expect(findings).toEqual([]);
  });

  it('matches a semver range', () => {
    const sources = osvSources({ ranges: ['>=9.0.0 <10.0.0'] });
    expect(layer2Findings({ name: 'evil-pkg', version: '9.1.6' }, sources)).toHaveLength(1);
    expect(layer2Findings({ name: 'evil-pkg', version: '10.0.0' }, sources)).toEqual([]);
  });

  it("treats '*' as match-all, even for non-semver versions", () => {
    const sources = osvSources({ ranges: ['*'] });
    expect(layer2Findings({ name: 'evil-pkg', version: '0.0.1' }, sources)).toHaveLength(1);
    expect(layer2Findings({ name: 'evil-pkg', version: 'not-semver' }, sources)).toHaveLength(1);
  });

  it('treats an entry with neither versions nor ranges as flagging all versions', () => {
    expect(layer2Findings({ name: 'evil-pkg', version: '7.7.7' }, osvSources({}))).toHaveLength(1);
  });

  it('returns no findings from empty sources', () => {
    expect(layer2Findings({ name: 'evil-pkg', version: '1.0.0' }, EMPTY)).toEqual([]);
  });
});

describe('layer2Findings — incident matching', () => {
  const sources: Layer2Sources = {
    osv: [],
    incidents: [
      {
        id: 'test-incident-jul26',
        name: 'Test incident',
        date: '2026-07-01',
        summary: 'incident summary',
        packages: [
          { name: 'evil-pkg', versions: ['3.0.0'] },
          { name: 'other-pkg', ranges: ['*'] },
        ],
      },
    ],
  };

  it('matches incident package versions and uses the LW2-IOC code', () => {
    const findings = layer2Findings({ name: 'evil-pkg', version: '3.0.0' }, sources);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'LW2-IOC-test-incident-jul26',
      severity: 'critical',
      layer2: { source: 'incident', id: 'test-incident-jul26', summary: 'incident summary' },
    });
  });

  it('does not match other versions', () => {
    expect(layer2Findings({ name: 'evil-pkg', version: '3.0.1' }, sources)).toEqual([]);
  });

  it('emits at most one finding per incident', () => {
    const doubled: Layer2Sources = {
      osv: [],
      incidents: [
        {
          id: 'dup',
          name: 'dup',
          date: '2026-07-01',
          summary: 's',
          packages: [{ name: 'evil-pkg' }, { name: 'evil-pkg', ranges: ['*'] }],
        },
      ],
    };
    expect(layer2Findings({ name: 'evil-pkg', version: '1.0.0' }, doubled)).toHaveLength(1);
  });
});

describe('loadLayer2Sources', () => {
  it('loads the vendored OSV snapshot and incident bundles', () => {
    const sources = loadLayer2Sources();
    expect(sources.osv.length).toBeGreaterThan(0);
    expect(sources.incidents.length).toBeGreaterThanOrEqual(3);
    expect(sources.incidents.map((i) => i.id)).toContain('node-ipc-may26');
  });

  it('flags node-ipc 9.1.6 via both the OSV snapshot and the incident bundle', () => {
    const findings = layer2Findings({ name: 'node-ipc', version: '9.1.6' }, loadLayer2Sources());
    // Refresh-proof: upstream OSV may carry additional MAL entries for the
    // same package — require ≥1 hit from EACH source, not an exact pair.
    const sourcesHit = new Set(findings.map((f) => f.layer2.source));
    expect(sourcesHit.has('incident')).toBe(true);
    expect(sourcesHit.has('osv')).toBe(true);
  });

  it('flags every plain-crypto-js version (match-all range)', () => {
    const findings = layer2Findings(
      { name: 'plain-crypto-js', version: '0.0.7' },
      loadLayer2Sources(),
    );
    expect(findings.length).toBeGreaterThanOrEqual(2); // OSV seed + axios-mar26 bundle
    for (const finding of findings) expect(finding.severity).toBe('critical');
  });

  it('does not flag a clean package', () => {
    expect(layer2Findings({ name: 'left-pad', version: '1.3.0' }, loadLayer2Sources())).toEqual([]);
  });
});
