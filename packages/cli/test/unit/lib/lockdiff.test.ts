import { describe, expect, it } from 'vitest';
import { diffGraphs, toDiffView } from '../../../src/lib/lockdiff.js';
import { ROOT } from '../../../src/lockfile/types.js';
import { buildGraph } from '../lockfile/helpers.js';

describe('diffGraphs', () => {
  it('returns an empty diff for identical graphs', () => {
    const base = buildGraph([
      [ROOT, 'foo@1.0.0'],
      ['foo@1.0.0', 'bar@2.0.0'],
    ]);
    const current = buildGraph([
      [ROOT, 'foo@1.0.0'],
      ['foo@1.0.0', 'bar@2.0.0'],
    ]);
    const diff = diffGraphs(base, current);
    expect(diff.changed.size).toBe(0);
    expect(diff.added.size).toBe(0);
    expect(diff.removed.size).toBe(0);
    expect(diff.addedTransitiveUnderPatch.size).toBe(0);
  });

  it('reports a single-version bump as changed, carrying base resolved+integrity', () => {
    const base = buildGraph([[ROOT, 'foo@1.0.0']]);
    const basePkg = base.packages.get('foo@1.0.0');
    if (basePkg === undefined) throw new Error('fixture bug');
    basePkg.resolved = 'https://registry.example/foo/-/foo-1.0.0.tgz';
    basePkg.integrity = 'sha512-AAAA';

    const current = buildGraph([[ROOT, 'foo@1.0.1']]);
    const diff = diffGraphs(base, current);

    expect(diff.changed.get('foo')).toEqual({
      from: '1.0.0',
      to: '1.0.1',
      baseResolved: 'https://registry.example/foo/-/foo-1.0.0.tgz',
      baseIntegrity: 'sha512-AAAA',
    });
    expect(diff.added.size).toBe(0);
    expect(diff.removed.size).toBe(0);
  });

  it('flags a new arrival under a patch bump (axios → plain-crypto-js shape)', () => {
    const base = buildGraph([[ROOT, 'axios@1.6.0']]);
    const current = buildGraph([
      [ROOT, 'axios@1.6.1'],
      ['axios@1.6.1', 'plain-crypto-js@1.0.0'],
    ]);
    const diff = diffGraphs(base, current);

    expect(diff.changed.get('axios')?.to).toBe('1.6.1');
    expect(diff.added.has('plain-crypto-js@1.0.0')).toBe(true);
    expect(diff.addedTransitiveUnderPatch.has('plain-crypto-js@1.0.0')).toBe(true);
  });

  it('does not mark arrivals as under-patch when the bump is minor', () => {
    const base = buildGraph([[ROOT, 'axios@1.6.0']]);
    const current = buildGraph([
      [ROOT, 'axios@1.7.0'],
      ['axios@1.7.0', 'newdep@1.0.0'],
    ]);
    const diff = diffGraphs(base, current);

    expect(diff.added.has('newdep@1.0.0')).toBe(true);
    expect(diff.addedTransitiveUnderPatch.size).toBe(0);
  });

  it('reports removed packages', () => {
    const base = buildGraph([
      [ROOT, 'foo@1.0.0'],
      [ROOT, 'gone@3.0.0'],
    ]);
    const current = buildGraph([[ROOT, 'foo@1.0.0']]);
    const diff = diffGraphs(base, current);
    expect(diff.removed.has('gone@3.0.0')).toBe(true);
    expect(diff.changed.size).toBe(0);
  });

  it('treats a second resolved version of an existing name as added, not changed', () => {
    const base = buildGraph([[ROOT, 'foo@1.0.0']]);
    const current = buildGraph([
      [ROOT, 'foo@1.0.0'],
      [ROOT, 'foo@2.0.0'],
    ]);
    const diff = diffGraphs(base, current);
    expect(diff.changed.size).toBe(0);
    expect(diff.added.has('foo@2.0.0')).toBe(true);
    expect(diff.removed.size).toBe(0);
  });

  it('uses per-key set difference when a name has multiple versions on either side', () => {
    const base = buildGraph([
      [ROOT, 'foo@1.0.0'],
      [ROOT, 'foo@2.0.0'],
    ]);
    const current = buildGraph([
      [ROOT, 'foo@1.0.1'],
      [ROOT, 'foo@2.0.0'],
    ]);
    const diff = diffGraphs(base, current);
    expect(diff.changed.size).toBe(0);
    expect(diff.added.has('foo@1.0.1')).toBe(true);
    expect(diff.removed.has('foo@1.0.0')).toBe(true);
  });

  it('handles scoped names in the under-patch set (name split on the LAST @)', () => {
    const base = buildGraph([[ROOT, 'lib@1.2.3']]);
    const current = buildGraph([
      [ROOT, 'lib@1.2.4'],
      ['lib@1.2.4', '@evil/payload@1.0.0'],
    ]);
    const diff = diffGraphs(base, current);
    expect(diff.added.has('@evil/payload@1.0.0')).toBe(true);
    expect(diff.addedTransitiveUnderPatch.has('@evil/payload@1.0.0')).toBe(true);
  });
});

describe('toDiffView', () => {
  it('mirrors changed pairs and the added/removed sets for analyzers', () => {
    const base = buildGraph([[ROOT, 'foo@1.0.0']]);
    const basePkg = base.packages.get('foo@1.0.0');
    if (basePkg === undefined) throw new Error('fixture bug');
    basePkg.resolved = 'https://registry.example/foo-1.0.0.tgz';

    const current = buildGraph([
      [ROOT, 'foo@1.0.1'],
      ['foo@1.0.1', 'new@1.0.0'],
    ]);
    const diff = diffGraphs(base, current);
    const view = toDiffView(diff);

    // analyzer view is severity- and URL-free: just version movements
    expect(view.changed.get('foo')).toEqual({ from: '1.0.0', to: '1.0.1' });
    expect(view.added).toBe(diff.added);
    expect(view.removed).toBe(diff.removed);
  });
});
