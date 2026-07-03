import { describe, expect, it } from 'vitest';
import { ROOT } from '../../../src/lockfile/types.js';
import { buildGraph } from './helpers.js';

describe('finalizeGraph', () => {
  it('deduplicates identical edges (same from/to/type/range)', () => {
    const graph = buildGraph([
      [ROOT, 'a@1.0.0', 'prod', '^1.0.0'],
      [ROOT, 'a@1.0.0', 'prod', '^1.0.0'],
      [ROOT, 'a@1.0.0', 'prod', '^1.1.0'], // different range survives
    ]);
    expect(graph.edges).toHaveLength(2);
    expect(graph.inbound.get('a@1.0.0')).toHaveLength(2);
  });

  it('dev wins only when a package is unreachable via prod/optional edges', () => {
    const graph = buildGraph([
      [ROOT, 'a@1.0.0', 'prod'],
      [ROOT, 'b@1.0.0', 'dev'],
      ['a@1.0.0', 'shared@1.0.0', 'prod'],
      ['b@1.0.0', 'shared@1.0.0', 'prod'],
      ['b@1.0.0', 'dev-only@1.0.0', 'prod'],
    ]);
    expect(graph.packages.get('a@1.0.0')?.dev).toBe(false);
    expect(graph.packages.get('b@1.0.0')?.dev).toBe(true);
    expect(graph.packages.get('shared@1.0.0')?.dev).toBe(false);
    expect(graph.packages.get('dev-only@1.0.0')?.dev).toBe(true);
  });

  it('optional wins only when a package is unreachable via prod/dev edges', () => {
    const graph = buildGraph([
      [ROOT, 'a@1.0.0', 'prod'],
      ['a@1.0.0', 'opt@1.0.0', 'optional'],
      ['opt@1.0.0', 'opt-child@1.0.0', 'prod'],
    ]);
    expect(graph.packages.get('opt@1.0.0')?.optional).toBe(true);
    expect(graph.packages.get('opt-child@1.0.0')?.optional).toBe(true);
    expect(graph.packages.get('opt@1.0.0')?.dev).toBe(false);
    expect(graph.packages.get('a@1.0.0')?.optional).toBe(false);
  });

  it('peer edges never carry reachability', () => {
    const graph = buildGraph([
      [ROOT, 'plugin@1.0.0', 'dev'],
      ['plugin@1.0.0', 'host@2.0.0', 'peer'],
      [ROOT, 'host@2.0.0', 'prod'],
    ]);
    // host is prod at root; the peer edge from a dev package must not matter
    expect(graph.packages.get('host@2.0.0')?.dev).toBe(false);
    expect(graph.packages.get('plugin@1.0.0')?.dev).toBe(true);
  });

  it('defaults dev/optional to false with a warning when no root edges exist', () => {
    const graph = buildGraph([['orphan-parent@1.0.0', 'orphan-child@1.0.0', 'prod']]);
    expect(graph.packages.get('orphan-child@1.0.0')?.dev).toBe(false);
    expect(graph.warnings.some((w) => w.includes('no root edges'))).toBe(true);
  });
});
