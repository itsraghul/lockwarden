import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePnpm } from '../../../src/lockfile/pnpm.js';
import { ROOT } from '../../../src/lockfile/types.js';
import { fixtureDir } from './helpers.js';

const CTX = { lockfilePath: '/test/pnpm-lock.yaml' };

describe('parsePnpm v9', () => {
  it('parses the pnpm-basic fixture (importers + packages + snapshots)', () => {
    const dir = fixtureDir('pnpm-basic');
    const graph = parsePnpm(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8'), {
      lockfilePath: join(dir, 'pnpm-lock.yaml'),
    });

    expect(graph.lockfileType).toBe('pnpm');
    expect(graph.lockfileVersion).toBe('9.0');
    expect([...graph.packages.keys()].sort()).toEqual([
      'ansi-tone@2.1.0',
      'left-pad@1.3.0',
      'react-widget@1.0.0',
      'react@18.2.0',
      'safe-logger@1.0.2',
      'test-runner-lite@5.0.3',
    ]);

    // peer-suffix stripped from the key, raw locator retained
    const widget = graph.packages.get('react-widget@1.0.0');
    expect(widget?.locators).toContain('react-widget@1.0.0');
    expect(widget?.locators).toContain('react-widget@1.0.0(react@18.2.0)');
    expect(widget?.integrity).toMatch(/^sha512-RW/);

    // root edges: specifier is the range, peer suffix stripped from the target
    const rootWidget = graph.edges.find((e) => e.from === ROOT && e.to === 'react-widget@1.0.0');
    expect(rootWidget?.range).toBe('^1.0.0');
    expect(rootWidget?.type).toBe('prod');

    // snapshot-carried dependency: react-widget -> react
    expect(
      graph.edges.some((e) => e.from === 'react-widget@1.0.0' && e.to === 'react@18.2.0'),
    ).toBe(true);

    // dev classification via reachability
    expect(graph.packages.get('test-runner-lite@5.0.3')?.dev).toBe(true);
    expect(graph.packages.get('ansi-tone@2.1.0')?.dev).toBe(false);
    expect(graph.warnings).toEqual([]);
  });

  it('strips nested peer suffixes in snapshot dependency values', () => {
    const content = `
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      a:
        specifier: ^1.0.0
        version: 1.0.0(b@2.0.0(c@3.0.0))
packages:
  a@1.0.0:
    resolution: {integrity: sha512-aaa}
  b@2.0.0:
    resolution: {integrity: sha512-bbb}
  c@3.0.0:
    resolution: {integrity: sha512-ccc}
snapshots:
  a@1.0.0(b@2.0.0(c@3.0.0)):
    dependencies:
      b: 2.0.0(c@3.0.0)
  b@2.0.0(c@3.0.0):
    dependencies:
      c: 3.0.0
  c@3.0.0: {}
`;
    const graph = parsePnpm(content, CTX);
    expect([...graph.packages.keys()].sort()).toEqual(['a@1.0.0', 'b@2.0.0', 'c@3.0.0']);
    expect(graph.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual([
      '<root>>a@1.0.0',
      'a@1.0.0>b@2.0.0',
      'b@2.0.0>c@3.0.0',
    ]);
  });
});

describe('parsePnpm v6', () => {
  const V6 = `
lockfileVersion: '6.0'

dependencies:
  safe-logger:
    specifier: ^1.0.0
    version: 1.0.2

devDependencies:
  test-runner-lite:
    specifier: ^5.0.0
    version: 5.0.3

packages:

  /ansi-tone@2.1.0:
    resolution: {integrity: sha512-aaa}
    dev: false

  /native-hook@1.1.0:
    resolution: {integrity: sha512-nnn}
    requiresBuild: true
    dev: false

  /safe-logger@1.0.2:
    resolution: {integrity: sha512-bbb}
    dependencies:
      ansi-tone: 2.1.0
      native-hook: 1.1.0
    dev: false

  /test-runner-lite@5.0.3:
    resolution: {integrity: sha512-ccc}
    dependencies:
      ansi-tone: 2.1.0
    dev: true
`;

  it('parses /name@version keys and top-level dependency sections', () => {
    const graph = parsePnpm(V6, CTX);
    expect(graph.lockfileVersion).toBe('6.0');
    expect([...graph.packages.keys()].sort()).toEqual([
      'ansi-tone@2.1.0',
      'native-hook@1.1.0',
      'safe-logger@1.0.2',
      'test-runner-lite@5.0.3',
    ]);
    expect(graph.packages.get('ansi-tone@2.1.0')?.locators).toEqual(['/ansi-tone@2.1.0']);
    expect(graph.packages.get('native-hook@1.1.0')?.hasInstallScript).toBe(true);

    const rootEdges = graph.edges.filter((e) => e.from === ROOT);
    expect(rootEdges.find((e) => e.to === 'safe-logger@1.0.2')?.type).toBe('prod');
    expect(rootEdges.find((e) => e.to === 'test-runner-lite@5.0.3')?.type).toBe('dev');

    expect(graph.packages.get('test-runner-lite@5.0.3')?.dev).toBe(true);
    expect(graph.packages.get('native-hook@1.1.0')?.dev).toBe(false);
    expect(graph.warnings).toEqual([]);
  });

  it('strips peer suffixes on v6 keys and dependency values', () => {
    const content = `
lockfileVersion: '6.0'
dependencies:
  '@scope/widget':
    specifier: ^1.0.0
    version: 1.0.0(react@18.2.0)
packages:
  /@scope/widget@1.0.0(react@18.2.0):
    resolution: {integrity: sha512-www}
    dependencies:
      react: 18.2.0
  /react@18.2.0:
    resolution: {integrity: sha512-rrr}
`;
    const graph = parsePnpm(content, CTX);
    expect(graph.packages.get('@scope/widget@1.0.0')?.locators).toEqual([
      '/@scope/widget@1.0.0(react@18.2.0)',
    ]);
    expect(
      graph.edges.some((e) => e.from === '@scope/widget@1.0.0' && e.to === 'react@18.2.0'),
    ).toBe(true);
  });

  it('skips workspace links with a warning', () => {
    const content = `
lockfileVersion: '6.0'
dependencies:
  local-pkg:
    specifier: workspace:*
    version: link:../local-pkg
packages: {}
`;
    const graph = parsePnpm(content, CTX);
    expect(graph.packages.size).toBe(0);
    expect(graph.warnings.some((w) => w.includes('link:../local-pkg'))).toBe(true);
  });
});

describe('parsePnpm errors', () => {
  it('throws ExecError on invalid YAML', () => {
    expect(() => parsePnpm('a: [unclosed', CTX)).toThrowError(/invalid YAML/);
  });

  it('throws ExecError when lockfileVersion is missing', () => {
    expect(() => parsePnpm('packages: {}\n', CTX)).toThrowError(/lockfileVersion/);
  });
});
