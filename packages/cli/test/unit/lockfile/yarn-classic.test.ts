import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../../src/lockfile/types.js';
import { parseYarnClassic } from '../../../src/lockfile/yarn-classic.js';
import { fixtureDir } from './helpers.js';

const CTX = { lockfilePath: '/test/yarn.lock' };

describe('parseYarnClassic', () => {
  it('parses the yarn-basic fixture (scoped packages, multi-descriptor, integrity)', () => {
    const dir = fixtureDir('yarn-basic');
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const graph = parseYarnClassic(readFileSync(join(dir, 'yarn.lock'), 'utf8'), {
      lockfilePath: join(dir, 'yarn.lock'),
      rootManifest: manifest,
    });

    expect(graph.lockfileType).toBe('yarn-classic');
    expect([...graph.packages.keys()].sort()).toEqual([
      '@scope/util@2.3.1',
      'ansi-tone@2.1.0',
      'left-pad@1.3.0',
      'safe-logger@1.0.2',
      'test-runner-lite@5.0.3',
    ]);

    // multi-descriptor header: both ranges land on the same package
    const ansi = graph.packages.get('ansi-tone@2.1.0');
    expect(ansi?.locators.sort()).toEqual(['ansi-tone@^2.0.0', 'ansi-tone@^2.1.0']);
    expect(ansi?.integrity).toMatch(/^sha512-1Xyz/);

    // scoped package parsed and reachable from root
    const scoped = graph.packages.get('@scope/util@2.3.1');
    expect(scoped?.name).toBe('@scope/util');
    expect(scoped?.resolved).toContain('util-2.3.1.tgz');
    expect(
      graph.edges.some((e) => e.from === ROOT && e.to === '@scope/util@2.3.1' && e.type === 'prod'),
    ).toBe(true);

    // dev classification comes from manifest-driven reachability
    expect(graph.packages.get('test-runner-lite@5.0.3')?.dev).toBe(true);
    expect(graph.packages.get('ansi-tone@2.1.0')?.dev).toBe(false);
    expect(graph.warnings).toEqual([]);
  });

  it('handles quoted multi-descriptor headers and nested dependency blocks', () => {
    const content = [
      '# yarn lockfile v1',
      '',
      '"@babel/helper@^7.0.0", "@babel/helper@^7.2.0":',
      '  version "7.5.5"',
      '  resolved "https://registry.yarnpkg.com/@babel/helper/-/helper-7.5.5.tgz#deadbeef"',
      '  integrity sha512-abc',
      '  dependencies:',
      '    "@babel/types" "^7.5.5"',
      '',
      '"@babel/types@^7.5.5":',
      '  version "7.5.5"',
      '  integrity sha512-def',
    ].join('\n');
    const graph = parseYarnClassic(content, {
      ...CTX,
      rootManifest: { dependencies: { '@babel/helper': '^7.0.0' } },
    });

    expect(graph.packages.get('@babel/helper@7.5.5')?.locators.sort()).toEqual([
      '@babel/helper@^7.0.0',
      '@babel/helper@^7.2.0',
    ]);
    expect(
      graph.edges.find((e) => e.from === '@babel/helper@7.5.5' && e.to === '@babel/types@7.5.5'),
    ).toBeDefined();
  });

  it('supports optionalDependencies blocks', () => {
    const content = [
      'fsevents@^2.0.0:',
      '  version "2.3.3"',
      '',
      'watcher@^1.0.0:',
      '  version "1.0.0"',
      '  optionalDependencies:',
      '    fsevents "^2.0.0"',
    ].join('\n');
    const graph = parseYarnClassic(content, {
      ...CTX,
      rootManifest: { dependencies: { watcher: '^1.0.0' } },
    });
    const edge = graph.edges.find((e) => e.to === 'fsevents@2.3.3');
    expect(edge?.type).toBe('optional');
    expect(graph.packages.get('fsevents@2.3.3')?.optional).toBe(true);
  });

  it('falls back to semver matching when a descriptor is missing, and warns otherwise', () => {
    const content = ['lib@~3.1.0:', '  version "3.1.4"'].join('\n');
    const graph = parseYarnClassic(content, {
      ...CTX,
      // manifest range differs from the lockfile descriptor
      rootManifest: { dependencies: { lib: '^3.0.0', ghost: '^1.0.0' } },
    });
    expect(graph.edges.some((e) => e.from === ROOT && e.to === 'lib@3.1.4')).toBe(true);
    expect(graph.warnings.some((w) => w.includes('ghost@^1.0.0'))).toBe(true);
  });

  it('classifies everything non-dev with a warning when no manifest is available', () => {
    const content = ['solo@^1.0.0:', '  version "1.0.0"'].join('\n');
    const graph = parseYarnClassic(content, CTX);
    expect(graph.packages.get('solo@1.0.0')?.dev).toBe(false);
    expect(graph.warnings.some((w) => w.includes('no root edges'))).toBe(true);
  });
});
