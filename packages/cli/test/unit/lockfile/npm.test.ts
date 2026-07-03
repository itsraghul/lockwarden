import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseNpm } from '../../../src/lockfile/npm.js';
import { ROOT } from '../../../src/lockfile/types.js';
import { fixtureDir } from './helpers.js';

const CTX = { lockfilePath: '/test/package-lock.json' };

function lock(packages: Record<string, unknown>, lockfileVersion = 3): string {
  return JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion, packages });
}

describe('parseNpm v3', () => {
  it('parses the npm-basic fixture into the unified model', () => {
    const dir = fixtureDir('npm-basic');
    const graph = parseNpm(readFileSync(join(dir, 'package-lock.json'), 'utf8'), {
      lockfilePath: join(dir, 'package-lock.json'),
    });

    expect(graph.lockfileType).toBe('npm');
    expect(graph.lockfileVersion).toBe('3');
    expect([...graph.packages.keys()].sort()).toEqual([
      'ansi-tone@2.1.0',
      'deep-merge-lite@1.1.4',
      'left-pad@1.3.0',
      'safe-logger@1.0.2',
      'test-runner-lite@5.0.3',
      'tiny-config@3.2.1',
    ]);

    const tinyConfig = graph.packages.get('tiny-config@3.2.1');
    expect(tinyConfig?.hasInstallScript).toBe(true);
    expect(tinyConfig?.integrity).toMatch(/^sha512-/);
    expect(tinyConfig?.resolved).toContain('tiny-config-3.2.1.tgz');
    expect(tinyConfig?.locators).toEqual(['node_modules/tiny-config']);

    // dev = reachable ONLY via dev edges from root
    expect(graph.packages.get('test-runner-lite@5.0.3')?.dev).toBe(true);
    // ansi-tone is shared by a prod dep (safe-logger) and a dev dep -> not dev
    expect(graph.packages.get('ansi-tone@2.1.0')?.dev).toBe(false);
    expect(graph.packages.get('left-pad@1.3.0')?.dev).toBe(false);

    // root edges carry the manifest ranges from the lockfile root entry
    const rootEdges = graph.edges.filter((e) => e.from === ROOT);
    expect(rootEdges).toHaveLength(4);
    expect(rootEdges.find((e) => e.to === 'test-runner-lite@5.0.3')?.type).toBe('dev');
    expect(rootEdges.find((e) => e.to === 'safe-logger@1.0.2')?.range).toBe('^1.0.0');

    // inbound reverse index
    const inboundAnsi = graph.inbound.get('ansi-tone@2.1.0') ?? [];
    expect(inboundAnsi.map((e) => e.from).sort()).toEqual([
      'safe-logger@1.0.2',
      'test-runner-lite@5.0.3',
    ]);
    expect(graph.warnings).toEqual([]);
  });

  it('resolves nested version conflicts by node_modules nesting depth', () => {
    const graph = parseNpm(
      lock({
        '': { name: 'app', version: '1.0.0', dependencies: { a: '^1.0.0', b: '^1.0.0' } },
        'node_modules/a': { version: '1.0.0', dependencies: { c: '^2.0.0' } },
        'node_modules/a/node_modules/c': { version: '2.5.0' },
        'node_modules/b': { version: '1.0.0', dependencies: { c: '^1.0.0' } },
        'node_modules/c': { version: '1.9.0' },
      }),
      CTX,
    );

    // two versions of c coexist
    expect(graph.packages.has('c@2.5.0')).toBe(true);
    expect(graph.packages.has('c@1.9.0')).toBe(true);

    // a gets its nested copy, b walks up to the hoisted one
    expect(graph.edges.find((e) => e.from === 'a@1.0.0' && e.type === 'prod')?.to).toBe('c@2.5.0');
    expect(graph.edges.find((e) => e.from === 'b@1.0.0' && e.type === 'prod')?.to).toBe('c@1.9.0');
  });

  it('parses the hit-transitive fixture with two paths into evil-pkg@1.2.3', () => {
    const dir = fixtureDir('hit-transitive');
    const graph = parseNpm(readFileSync(join(dir, 'package-lock.json'), 'utf8'), {
      lockfilePath: join(dir, 'package-lock.json'),
    });

    expect(graph.packages.has('evil-pkg@1.2.3')).toBe(true);
    expect(graph.packages.has('evil-pkg@2.0.0')).toBe(true);

    const inbound123 = graph.inbound.get('evil-pkg@1.2.3') ?? [];
    expect(inbound123.map((e) => e.from).sort()).toEqual(['app-lib@1.0.0', 'nested-lib@3.0.1']);
    const inbound200 = graph.inbound.get('evil-pkg@2.0.0') ?? [];
    expect(inbound200.map((e) => e.from)).toEqual(['modern-lib@4.0.0']);
    expect(graph.packages.get('evil-pkg@2.0.0')?.locators).toEqual([
      'node_modules/modern-lib/node_modules/evil-pkg',
    ]);
  });

  it('marks optional-only subtrees optional and warns on unresolvable prod deps', () => {
    const graph = parseNpm(
      lock({
        '': { name: 'app', version: '1.0.0', optionalDependencies: { opt: '^1.0.0' } },
        'node_modules/opt': { version: '1.0.0', dependencies: { ghost: '^9.9.9' } },
      }),
      CTX,
    );
    expect(graph.packages.get('opt@1.0.0')?.optional).toBe(true);
    expect(graph.packages.get('opt@1.0.0')?.dev).toBe(false);
    expect(graph.warnings.some((w) => w.includes('ghost@^9.9.9'))).toBe(true);
  });

  it('skips workspace links and non-node_modules entries with a warning', () => {
    const graph = parseNpm(
      lock({
        '': { name: 'app', version: '1.0.0', dependencies: { a: '^1.0.0' } },
        'node_modules/a': { version: '1.0.0' },
        'node_modules/ws-pkg': { link: true, resolved: 'packages/ws-pkg' },
        'packages/ws-pkg': { name: 'ws-pkg', version: '0.0.1' },
      }),
      CTX,
    );
    expect(graph.packages.size).toBe(1);
    expect(graph.warnings.some((w) => w.includes('packages/ws-pkg'))).toBe(true);
  });

  it('throws ExecError on invalid JSON', () => {
    expect(() => parseNpm('{ nope', CTX)).toThrowError(/invalid JSON/);
  });
});

describe('parseNpm v2', () => {
  it('uses the packages map and ignores the legacy dependencies block', () => {
    const content = JSON.stringify({
      name: 'app',
      version: '1.0.0',
      lockfileVersion: 2,
      packages: {
        '': { name: 'app', version: '1.0.0', dependencies: { a: '^1.0.0' } },
        'node_modules/a': {
          version: '1.2.0',
          resolved: 'https://registry.npmjs.org/a/-/a-1.2.0.tgz',
          integrity: 'sha512-fake',
        },
      },
      dependencies: {
        a: { version: '1.2.0', integrity: 'sha512-legacy-should-be-ignored' },
      },
    });
    const graph = parseNpm(content, CTX);
    expect(graph.lockfileVersion).toBe('2');
    expect(graph.packages.get('a@1.2.0')?.integrity).toBe('sha512-fake');
    expect(graph.edges).toHaveLength(1);
    expect(graph.warnings).toEqual([]);
  });
});

describe('parseNpm v1 fallback', () => {
  const v1 = JSON.stringify({
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 1,
    dependencies: {
      a: {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
        integrity: 'sha512-aaa',
        requires: { c: '^2.0.0' },
        dependencies: {
          c: { version: '2.5.0' },
        },
      },
      b: {
        version: '1.0.0',
        dev: true,
        requires: { c: '^1.0.0' },
      },
      c: { version: '1.9.0' },
    },
  });

  it('best-effort parses the nested dependencies tree and warns', () => {
    const graph = parseNpm(v1, CTX);
    expect(graph.lockfileVersion).toBe('1');
    expect(graph.warnings.some((w) => w.includes('best-effort'))).toBe(true);
    expect([...graph.packages.keys()].sort()).toEqual(['a@1.0.0', 'b@1.0.0', 'c@1.9.0', 'c@2.5.0']);

    // nested resolution: a sees its nested c@2.5.0, b walks up to c@1.9.0
    expect(graph.edges.find((e) => e.from === 'a@1.0.0')?.to).toBe('c@2.5.0');
    expect(graph.edges.find((e) => e.from === 'b@1.0.0')?.to).toBe('c@1.9.0');
  });

  it('classifies root edges from the manifest when provided', () => {
    const graph = parseNpm(v1, {
      ...CTX,
      rootManifest: {
        dependencies: { a: '^1.0.0' },
        devDependencies: { b: '^1.0.0' },
      },
    });
    expect(graph.packages.get('b@1.0.0')?.dev).toBe(true);
    expect(graph.packages.get('a@1.0.0')?.dev).toBe(false);
    expect(graph.packages.get('c@2.5.0')?.dev).toBe(false);
  });
});
