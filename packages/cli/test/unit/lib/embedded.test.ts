import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../../../src/analyzers/types.js';
import { MAX_EMBEDDED_ROOTS, findEmbeddedRoots } from '../../../src/lib/embedded.js';

function fileMap(files: Record<string, string>): Map<string, FileEntry> {
  const map = new Map<string, FileEntry>();
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    map.set(path, { path, size: data.length, read: () => Promise.resolve(data) });
  }
  return map;
}

function manifest(name: string, version = '1.0.0', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name, version, ...extra });
}

describe('findEmbeddedRoots — discovery', () => {
  it('finds the artifact root, node_modules roots and scoped node_modules roots', async () => {
    const { packages, warnings } = await findEmbeddedRoots(
      fileMap({
        'package.json': manifest('app'),
        'index.js': 'require("a");',
        'node_modules/a/package.json': manifest('a'),
        'node_modules/a/index.js': 'module.exports = 1;',
        'node_modules/@scope/b/package.json': manifest('@scope/b', '2.0.0'),
        'node_modules/@scope/b/lib/main.js': 'module.exports = 2;',
      }),
    );
    expect(warnings).toEqual([]);
    expect(packages.map((p) => p.root)).toEqual(['', 'node_modules/@scope/b', 'node_modules/a']);
    const scoped = packages.find((p) => p.root === 'node_modules/@scope/b');
    expect(scoped?.artifact.name).toBe('@scope/b');
    expect(scoped?.artifact.version).toBe('2.0.0');
  });

  it('finds nested node_modules roots and roots under a tarball top dir', async () => {
    const { packages } = await findEmbeddedRoots(
      fileMap({
        'package/package.json': manifest('app'),
        'package/node_modules/a/package.json': manifest('a'),
        'package/node_modules/a/node_modules/b/package.json': manifest('b', '3.0.0'),
      }),
    );
    expect(packages.map((p) => p.root)).toEqual([
      'package',
      'package/node_modules/a',
      'package/node_modules/a/node_modules/b',
    ]);
    expect(packages[2]?.artifact.version).toBe('3.0.0');
  });

  it('ignores package.json files that fail to parse or lack a name+version', async () => {
    const { packages } = await findEmbeddedRoots(
      fileMap({
        'package.json': '{ not json',
        'node_modules/x/package.json': manifest('x'),
        'node_modules/noversion/package.json': JSON.stringify({ name: 'noversion' }),
        'node_modules/noname/package.json': JSON.stringify({ version: '1.0.0' }),
        'node_modules/arr/package.json': '[1,2,3]',
      }),
    );
    expect(packages.map((p) => p.root)).toEqual(['node_modules/x']);
  });

  it('returns no roots for an artifact without any package.json', async () => {
    const { packages, warnings } = await findEmbeddedRoots(
      fileMap({ 'src/main.c': 'int main() {}' }),
    );
    expect(packages).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('findEmbeddedRoots — file scoping', () => {
  it('scopes files under each root, relative to it, excluding nested node_modules', async () => {
    const { packages } = await findEmbeddedRoots(
      fileMap({
        'package.json': manifest('app', '1.0.0', { scripts: { postinstall: 'node x.js' } }),
        'index.js': 'app',
        'node_modules/a/package.json': manifest('a'),
        'node_modules/a/index.js': 'a',
        'node_modules/a/node_modules/b/package.json': manifest('b'),
        'node_modules/a/node_modules/b/index.js': 'b',
      }),
    );
    const app = packages.find((p) => p.root === '');
    expect([...(app?.artifact.files.keys() ?? [])].sort()).toEqual(['index.js', 'package.json']);
    expect(app?.artifact.manifest.scripts).toEqual({ postinstall: 'node x.js' });

    const a = packages.find((p) => p.root === 'node_modules/a');
    expect([...(a?.artifact.files.keys() ?? [])].sort()).toEqual(['index.js', 'package.json']);
    expect(a?.artifact.totalSize).toBeGreaterThan(0);

    const b = packages.find((p) => p.root === 'node_modules/a/node_modules/b');
    expect([...(b?.artifact.files.keys() ?? [])].sort()).toEqual(['index.js', 'package.json']);
  });
});

describe('findEmbeddedRoots — cap', () => {
  it(`caps discovery at ${MAX_EMBEDDED_ROOTS} roots, keeping node_modules roots, and warns`, async () => {
    const files: Record<string, string> = {
      // non-node_modules roots compete for slots but lose to nm roots
      'package.json': manifest('app'),
      'workspaces/w1/package.json': manifest('w1'),
      'workspaces/w2/package.json': manifest('w2'),
    };
    for (let i = 0; i < MAX_EMBEDDED_ROOTS + 10; i++) {
      files[`node_modules/p${i}/package.json`] = manifest(`p${i}`);
    }
    const { packages, warnings } = await findEmbeddedRoots(fileMap(files));
    expect(packages).toHaveLength(MAX_EMBEDDED_ROOTS);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`capped at ${MAX_EMBEDDED_ROOTS}`);
    expect(warnings[0]).toContain(`found ${MAX_EMBEDDED_ROOTS + 13}`);
    // every kept root is a node_modules root — preference protected them
    expect(packages.every((p) => p.root.startsWith('node_modules/'))).toBe(true);
  });
});
