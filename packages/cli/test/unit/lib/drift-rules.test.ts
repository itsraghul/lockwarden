import { describe, expect, it } from 'vitest';
import {
  bumpIntroducedDepFindings,
  bumpKind,
  computeDriftFindings,
  integritySwapFindings,
  manifestRange,
  resolvedUrlMoveFindings,
  unexplainedVersionFindings,
} from '../../../src/lib/drift-rules.js';
import { diffGraphs } from '../../../src/lib/lockdiff.js';
import { type PkgKey, ROOT, type ResolutionGraph } from '../../../src/lockfile/types.js';
import { buildGraph } from '../lockfile/helpers.js';

/** Patch a package built by buildGraph (integrity / resolved fields). */
function setPkg(
  graph: ResolutionGraph,
  key: PkgKey,
  patch: { integrity?: string; resolved?: string },
): void {
  const pkg = graph.packages.get(key);
  if (pkg === undefined) throw new Error(`no such package in graph: ${key}`);
  Object.assign(pkg, patch);
}

const NPM = 'https://registry.npmjs.org';

describe('bumpKind', () => {
  it('classifies patch and minor bumps', () => {
    expect(bumpKind('1.0.0', '1.0.1')).toBe('patch');
    expect(bumpKind('1.0.0', '1.1.0')).toBe('minor');
  });

  it('rejects major bumps, downgrades, prereleases, and junk', () => {
    expect(bumpKind('1.0.0', '2.0.0')).toBeNull();
    expect(bumpKind('1.0.1', '1.0.0')).toBeNull();
    expect(bumpKind('1.0.0', '1.0.1-beta.1')).toBeNull();
    expect(bumpKind('not-a-version', '1.0.1')).toBeNull();
  });
});

describe('manifestRange', () => {
  it('finds ranges across dependency sections', () => {
    const manifest = {
      dependencies: { a: '^1.0.0' },
      devDependencies: { b: '~2.0.0' },
    };
    expect(manifestRange(manifest, 'a')).toBe('^1.0.0');
    expect(manifestRange(manifest, 'b')).toBe('~2.0.0');
    expect(manifestRange(manifest, 'c')).toBeUndefined();
    expect(manifestRange(undefined, 'a')).toBeUndefined();
  });
});

describe('integritySwapFindings', () => {
  it('flags same name@version with a different integrity as critical', () => {
    const base = buildGraph([[ROOT, 'foo@1.0.0']]);
    const current = buildGraph([[ROOT, 'foo@1.0.0']]);
    setPkg(base, 'foo@1.0.0', { integrity: 'sha512-old' });
    setPkg(current, 'foo@1.0.0', { integrity: 'sha512-new' });

    const findings = integritySwapFindings(base, current);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('critical');
    expect(findings[0]?.package).toBe('foo@1.0.0');
  });

  it('stays quiet on identical or missing integrity', () => {
    const base = buildGraph([[ROOT, 'foo@1.0.0']]);
    const current = buildGraph([[ROOT, 'foo@1.0.0']]);
    setPkg(base, 'foo@1.0.0', { integrity: 'sha512-same' });
    setPkg(current, 'foo@1.0.0', { integrity: 'sha512-same' });
    expect(integritySwapFindings(base, current)).toHaveLength(0);

    const noHash = buildGraph([[ROOT, 'foo@1.0.0']]);
    expect(integritySwapFindings(noHash, current)).toHaveLength(0);
  });
});

describe('resolvedUrlMoveFindings', () => {
  it('rates a host move high and a path-only move med for an unchanged version', () => {
    const base = buildGraph([
      [ROOT, 'foo@1.0.0'],
      [ROOT, 'bar@1.0.0'],
    ]);
    const current = buildGraph([
      [ROOT, 'foo@1.0.0'],
      [ROOT, 'bar@1.0.0'],
    ]);
    setPkg(base, 'foo@1.0.0', { resolved: `${NPM}/foo/-/foo-1.0.0.tgz` });
    setPkg(current, 'foo@1.0.0', { resolved: 'https://evil.example.com/foo/-/foo-1.0.0.tgz' });
    setPkg(base, 'bar@1.0.0', { resolved: `${NPM}/bar/-/bar-1.0.0.tgz` });
    setPkg(current, 'bar@1.0.0', { resolved: `${NPM}/bar/-/bar-1.0.0-rebuilt.tgz` });

    const findings = resolvedUrlMoveFindings(base, current, diffGraphs(base, current));
    expect(findings).toHaveLength(2);
    const foo = findings.find((f) => f.package === 'foo@1.0.0');
    const bar = findings.find((f) => f.package === 'bar@1.0.0');
    expect(foo?.severity).toBe('high');
    expect(bar?.severity).toBe('med');
  });

  it('flags a host move across a version bump but not the expected path change', () => {
    const base = buildGraph([
      [ROOT, 'foo@1.0.0'],
      [ROOT, 'bar@1.0.0'],
    ]);
    const current = buildGraph([
      [ROOT, 'foo@1.0.1'],
      [ROOT, 'bar@1.0.1'],
    ]);
    setPkg(base, 'foo@1.0.0', { resolved: `${NPM}/foo/-/foo-1.0.0.tgz` });
    setPkg(current, 'foo@1.0.1', { resolved: 'https://evil.example.com/foo/-/foo-1.0.1.tgz' });
    setPkg(base, 'bar@1.0.0', { resolved: `${NPM}/bar/-/bar-1.0.0.tgz` });
    setPkg(current, 'bar@1.0.1', { resolved: `${NPM}/bar/-/bar-1.0.1.tgz` });

    const findings = resolvedUrlMoveFindings(base, current, diffGraphs(base, current));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.package).toBe('foo@1.0.1');
    expect(findings[0]?.severity).toBe('high');
  });
});

describe('unexplainedVersionFindings', () => {
  it('flags a transitive bump that satisfies no inbound range', () => {
    const base = buildGraph([
      [ROOT, 'app@1.0.0', 'prod', '^1.0.0'],
      ['app@1.0.0', 'dep@1.2.0', 'prod', '^1.0.0'],
    ]);
    const current = buildGraph([
      [ROOT, 'app@1.0.0', 'prod', '^1.0.0'],
      ['app@1.0.0', 'dep@9.9.9', 'prod', '^1.0.0'],
    ]);
    const findings = unexplainedVersionFindings({ base, current }, diffGraphs(base, current));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('unexplained-version');
    expect(findings[0]?.severity).toBe('high');
    expect(findings[0]?.package).toBe('dep@9.9.9');
  });

  it('stays quiet when an inbound range in the current graph explains the move', () => {
    const base = buildGraph([
      [ROOT, 'app@1.0.0', 'prod', '^1.0.0'],
      ['app@1.0.0', 'dep@1.2.0', 'prod', '^1.0.0'],
    ]);
    const current = buildGraph([
      [ROOT, 'app@1.0.0', 'prod', '^1.0.0'],
      ['app@1.0.0', 'dep@2.0.0', 'prod', '^2.0.0'], // parent widened its range
    ]);
    expect(unexplainedVersionFindings({ base, current }, diffGraphs(base, current))).toHaveLength(
      0,
    );
  });

  it('cannot judge non-semver inbound ranges and stays quiet', () => {
    const base = buildGraph([['app@1.0.0', 'dep@1.0.0', 'prod', 'github:x/y']]);
    const current = buildGraph([['app@1.0.0', 'dep@9.9.9', 'prod', 'github:x/y']]);
    expect(unexplainedVersionFindings({ base, current }, diffGraphs(base, current))).toHaveLength(
      0,
    );
  });

  it('flags a direct dep moved outside an unchanged package.json range', () => {
    const manifest = { dependencies: { dep: '^1.0.0' } };
    const base = buildGraph([[ROOT, 'dep@1.2.0', 'prod', '^1.0.0']]);
    const current = buildGraph([[ROOT, 'dep@2.0.0', 'prod', '^1.0.0']]);
    const findings = unexplainedVersionFindings(
      { base, current, baseManifest: manifest, currentManifest: manifest },
      diffGraphs(base, current),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.package).toBe('dep@2.0.0');
  });

  it('treats a changed package.json range as an intentional bump', () => {
    const base = buildGraph([[ROOT, 'dep@1.2.0', 'prod', '^1.0.0']]);
    const current = buildGraph([[ROOT, 'dep@2.0.0', 'prod', '^2.0.0']]);
    const findings = unexplainedVersionFindings(
      {
        base,
        current,
        baseManifest: { dependencies: { dep: '^1.0.0' } },
        currentManifest: { dependencies: { dep: '^2.0.0' } },
      },
      diffGraphs(base, current),
    );
    expect(findings).toHaveLength(0);
  });

  it('does not flag a direct dep that moved WITHIN its unchanged range', () => {
    const manifest = { dependencies: { dep: '^1.0.0' } };
    const base = buildGraph([[ROOT, 'dep@1.2.0', 'prod', '^1.0.0']]);
    const current = buildGraph([[ROOT, 'dep@1.3.0', 'prod', '^1.0.0']]);
    const findings = unexplainedVersionFindings(
      { base, current, baseManifest: manifest, currentManifest: manifest },
      diffGraphs(base, current),
    );
    expect(findings).toHaveLength(0);
  });
});

describe('bumpIntroducedDepFindings', () => {
  it('flags arrivals under a patch bump AND under a minor bump', () => {
    for (const bumpedTo of ['1.0.1', '1.1.0']) {
      const base = buildGraph([[ROOT, 'lib@1.0.0', 'prod', '^1.0.0']]);
      const current = buildGraph([
        [ROOT, `lib@${bumpedTo}`, 'prod', '^1.0.0'],
        [`lib@${bumpedTo}`, 'payload@1.0.0', 'prod', '^1.0.0'],
      ]);
      const findings = bumpIntroducedDepFindings(diffGraphs(base, current));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.kind).toBe('patch-introduced-dep');
      expect(findings[0]?.severity).toBe('high');
      expect(findings[0]?.package).toBe('payload@1.0.0');
    }
  });

  it('stays quiet when the arrival comes with a major bump', () => {
    const base = buildGraph([[ROOT, 'lib@1.0.0', 'prod', '^1.0.0']]);
    const current = buildGraph([
      [ROOT, 'lib@2.0.0', 'prod', '^2.0.0'],
      ['lib@2.0.0', 'payload@1.0.0', 'prod', '^1.0.0'],
    ]);
    expect(bumpIntroducedDepFindings(diffGraphs(base, current))).toHaveLength(0);
  });
});

describe('computeDriftFindings', () => {
  it('returns an empty list for identical graphs', () => {
    const base = buildGraph([[ROOT, 'foo@1.0.0']]);
    const current = buildGraph([[ROOT, 'foo@1.0.0']]);
    expect(computeDriftFindings({ base, current })).toHaveLength(0);
  });

  it('sorts findings worst-severity first', () => {
    const base = buildGraph([
      [ROOT, 'foo@1.0.0'],
      [ROOT, 'bar@1.0.0'],
    ]);
    const current = buildGraph([
      [ROOT, 'foo@1.0.0'],
      [ROOT, 'bar@1.0.0'],
    ]);
    // med: path-only url move on bar
    setPkg(base, 'bar@1.0.0', { resolved: `${NPM}/bar/-/bar-1.0.0.tgz` });
    setPkg(current, 'bar@1.0.0', { resolved: `${NPM}/bar/-/bar-1.0.0-alt.tgz` });
    // critical: integrity swap on foo
    setPkg(base, 'foo@1.0.0', { integrity: 'sha512-old' });
    setPkg(current, 'foo@1.0.0', { integrity: 'sha512-new' });

    const findings = computeDriftFindings({ base, current });
    expect(findings.map((f) => f.kind)).toEqual(['integrity-swap', 'resolved-url-move']);
    expect(findings.map((f) => f.severity)).toEqual(['critical', 'med']);
  });
});
