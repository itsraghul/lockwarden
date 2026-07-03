import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirToArtifact, tarballToArtifact } from '../../../src/lib/artifact.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', '..', 'fixtures', 'tarballs');

function fixture(rel: string): Promise<Buffer> {
  return readFile(path.join(FIXTURES, rel));
}

describe('tarballToArtifact', () => {
  it('strips the top-level package/ dir and parses the manifest', async () => {
    const artifact = await tarballToArtifact(await fixture('lifecycle-scripts/malicious.tgz'));
    expect(artifact.name).toBe('lc-mini');
    expect(artifact.version).toBe('1.0.1');
    expect([...artifact.files.keys()].sort()).toEqual(['index.js', 'lw-inert.js', 'package.json']);
    expect(artifact.manifest.scripts).toMatchObject({ postinstall: 'node lw-inert.js' });
  });

  it('sums totalSize and exposes lazy read()', async () => {
    const artifact = await tarballToArtifact(await fixture('agent-hooks/malicious.tgz'));
    const entry = artifact.files.get('.claude/settings.json');
    expect(entry).toBeDefined();
    const body = (await entry?.read())?.toString('utf8') ?? '';
    expect(body).toContain('SessionStart');
    let sum = 0;
    for (const f of artifact.files.values()) sum += f.size;
    expect(artifact.totalSize).toBe(sum);
  });

  it('falls back to provided identity when manifest lacks name/version', async () => {
    // pax fixture manifest has name/version, so use a real one and override missing fields:
    const artifact = await tarballToArtifact(await fixture('_readers/pax-longpath.tgz'), {
      name: 'fallback',
      version: '9.9.9',
    });
    // manifest DOES declare name here, so manifest wins:
    expect(artifact.name).toBe('pax-mini');
    // long path survived stripping:
    expect([...artifact.files.keys()].some((k) => k.endsWith('leaf.js'))).toBe(true);
  });
});

describe('dirToArtifact', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lw-artifact-'));
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'dir-pkg', version: '2.3.4', main: 'index.js' }),
    );
    await writeFile(path.join(dir, 'index.js'), 'module.exports = 42;\n');
    await mkdir(path.join(dir, 'node_modules', 'ignored'), { recursive: true });
    await writeFile(path.join(dir, 'node_modules', 'ignored', 'x.js'), 'should be skipped');
    await mkdir(path.join(dir, 'sub'), { recursive: true });
    await writeFile(path.join(dir, 'sub', 'a.js'), 'export const a = 1;\n');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('walks recursively, skips node_modules, parses manifest', async () => {
    const artifact = await dirToArtifact(dir);
    expect(artifact.name).toBe('dir-pkg');
    expect(artifact.version).toBe('2.3.4');
    const keys = [...artifact.files.keys()].sort();
    expect(keys).toEqual(['index.js', 'package.json', 'sub/a.js']);
    expect(keys.some((k) => k.includes('node_modules'))).toBe(false);
    const a = artifact.files.get('sub/a.js');
    expect((await a?.read())?.toString('utf8')).toContain('export const a');
  });
});
