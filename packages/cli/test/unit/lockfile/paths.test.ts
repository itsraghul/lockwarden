import { describe, expect, it } from 'vitest';
import { loadGraph } from '../../../src/lockfile/detect.js';
import { enumeratePaths, matchPackages } from '../../../src/lockfile/paths.js';
import type { PkgKey, RootMarker } from '../../../src/lockfile/types.js';
import { ROOT } from '../../../src/lockfile/types.js';
import { buildGraph, fixtureDir } from './helpers.js';

function render(path: Array<{ key: PkgKey | RootMarker; range?: string }>): string {
  return path.map((step) => step.key).join(' > ');
}

describe('enumeratePaths', () => {
  it('finds both sides of a diamond dependency', () => {
    const graph = buildGraph([
      [ROOT, 'a@1.0.0'],
      [ROOT, 'b@1.0.0'],
      ['a@1.0.0', 'c@1.0.0'],
      ['b@1.0.0', 'c@1.0.0'],
    ]);
    const { paths, truncated } = enumeratePaths(graph, 'c@1.0.0');
    expect(truncated).toBe(false);
    expect(paths.map(render).sort()).toEqual([
      '<root> > a@1.0.0 > c@1.0.0',
      '<root> > b@1.0.0 > c@1.0.0',
    ]);
  });

  it('attaches the inbound range to each step', () => {
    const graph = buildGraph([
      [ROOT, 'a@1.0.0', 'prod', '^1.0.0'],
      ['a@1.0.0', 'c@2.0.0', 'prod', '~2.0.0'],
    ]);
    const { paths } = enumeratePaths(graph, 'c@2.0.0');
    expect(paths).toEqual([
      [{ key: ROOT }, { key: 'a@1.0.0', range: '^1.0.0' }, { key: 'c@2.0.0', range: '~2.0.0' }],
    ]);
  });

  it('terminates on cycles and still finds the acyclic path', () => {
    const graph = buildGraph([
      [ROOT, 'a@1.0.0'],
      ['a@1.0.0', 'b@1.0.0'],
      ['b@1.0.0', 'a@1.0.0'], // a -> b -> a
    ]);
    const { paths, truncated } = enumeratePaths(graph, 'b@1.0.0');
    expect(truncated).toBe(false);
    expect(paths.map(render)).toEqual(['<root> > a@1.0.0 > b@1.0.0']);

    // the cycle participant itself is also enumerable; only SIMPLE paths count,
    // so root > a > b > a is not reported
    const aResult = enumeratePaths(graph, 'a@1.0.0');
    expect(aResult.paths.map(render)).toEqual(['<root> > a@1.0.0']);
  });

  it('truncates once maxPaths simple paths were collected', () => {
    const fanIn: Array<[PkgKey | RootMarker, PkgKey]> = [];
    for (let i = 0; i < 10; i += 1) {
      fanIn.push([ROOT, `mid-${i}@1.0.0` as PkgKey]);
      fanIn.push([`mid-${i}@1.0.0` as PkgKey, 'target@1.0.0']);
    }
    const graph = buildGraph(fanIn);

    const capped = enumeratePaths(graph, 'target@1.0.0', { maxPaths: 3 });
    expect(capped.paths).toHaveLength(3);
    expect(capped.truncated).toBe(true);

    const uncapped = enumeratePaths(graph, 'target@1.0.0');
    expect(uncapped.paths).toHaveLength(10);
    expect(uncapped.truncated).toBe(false);
  });

  it('returns no paths for keys that are not in the graph', () => {
    const graph = buildGraph([[ROOT, 'a@1.0.0']]);
    expect(enumeratePaths(graph, 'ghost@9.9.9')).toEqual({ paths: [], truncated: false });
  });

  it('reports every transitive entry path in the hit-transitive fixture', () => {
    const graph = loadGraph(fixtureDir('hit-transitive'));
    const { paths, truncated } = enumeratePaths(graph, 'evil-pkg@1.2.3');
    expect(truncated).toBe(false);
    expect(paths.map(render).sort()).toEqual([
      '<root> > app-lib@1.0.0 > evil-pkg@1.2.3',
      '<root> > other-lib@2.0.0 > nested-lib@3.0.1 > evil-pkg@1.2.3',
    ]);

    const v2 = enumeratePaths(graph, 'evil-pkg@2.0.0');
    expect(v2.paths.map(render)).toEqual(['<root> > modern-lib@4.0.0 > evil-pkg@2.0.0']);
  });
});

describe('matchPackages', () => {
  const graph = buildGraph([
    [ROOT, 'lodash@4.17.21'],
    [ROOT, 'lodash@3.10.1'],
    [ROOT, '@scope/pkg@1.2.3'],
    [ROOT, '@scope/pkg@2.0.0'],
  ]);

  it('matches all versions on a bare name', () => {
    expect(matchPackages(graph, 'lodash')).toEqual(['lodash@3.10.1', 'lodash@4.17.21']);
  });

  it('matches an exact version', () => {
    expect(matchPackages(graph, 'lodash@4.17.21')).toEqual(['lodash@4.17.21']);
  });

  it('matches semver ranges', () => {
    expect(matchPackages(graph, 'lodash@^4')).toEqual(['lodash@4.17.21']);
    expect(matchPackages(graph, 'lodash@>=3 <4')).toEqual(['lodash@3.10.1']);
    expect(matchPackages(graph, 'lodash@^1 || ^3')).toEqual(['lodash@3.10.1']);
  });

  it('parses scoped names on the last @ that is not position 0', () => {
    expect(matchPackages(graph, '@scope/pkg')).toEqual(['@scope/pkg@1.2.3', '@scope/pkg@2.0.0']);
    expect(matchPackages(graph, '@scope/pkg@>=2 <3')).toEqual(['@scope/pkg@2.0.0']);
    expect(matchPackages(graph, '@scope/pkg@1.2.3')).toEqual(['@scope/pkg@1.2.3']);
  });

  it('returns empty for unknown names or unsatisfied ranges', () => {
    expect(matchPackages(graph, 'ghost')).toEqual([]);
    expect(matchPackages(graph, 'lodash@^9')).toEqual([]);
  });
});
