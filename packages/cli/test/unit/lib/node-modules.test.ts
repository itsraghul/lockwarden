import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { locateInstalled } from '../../../src/lib/node-modules.js';

const roots: string[] = [];

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lockwarden-nm-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Write a minimal installed package at <base>/<...segments>. */
async function writePkg(base: string, segments: string[], name: string, version: string) {
  const dir = join(base, ...segments);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version }));
  return dir;
}

describe('locateInstalled — hoisted layout', () => {
  it('finds a package directly under node_modules', async () => {
    const project = tmpProject();
    const expected = await writePkg(project, ['node_modules', 'foo'], 'foo', '1.0.0');
    await expect(locateInstalled(project, 'foo', '1.0.0')).resolves.toBe(expected);
  });

  it('finds a scoped package directly under node_modules', async () => {
    const project = tmpProject();
    const expected = await writePkg(
      project,
      ['node_modules', '@scope', 'pkg'],
      '@scope/pkg',
      '2.1.0',
    );
    await expect(locateInstalled(project, '@scope/pkg', '2.1.0')).resolves.toBe(expected);
  });

  it('rejects a hoisted copy whose version does not match the lockfile', async () => {
    const project = tmpProject();
    await writePkg(project, ['node_modules', 'foo'], 'foo', '2.0.0');
    await expect(locateInstalled(project, 'foo', '1.0.0')).resolves.toBeNull();
  });

  it('returns null when node_modules does not exist at all', async () => {
    const project = tmpProject();
    await expect(locateInstalled(project, 'foo', '1.0.0')).resolves.toBeNull();
  });
});

describe('locateInstalled — pnpm store layout', () => {
  it('finds a package in .pnpm/<name>@<version>/node_modules/<name>', async () => {
    const project = tmpProject();
    const expected = await writePkg(
      project,
      ['node_modules', '.pnpm', 'foo@1.0.0', 'node_modules', 'foo'],
      'foo',
      '1.0.0',
    );
    await expect(locateInstalled(project, 'foo', '1.0.0')).resolves.toBe(expected);
  });

  it('matches a .pnpm entry carrying a peer-dependency suffix', async () => {
    const project = tmpProject();
    const expected = await writePkg(
      project,
      ['node_modules', '.pnpm', 'foo@1.0.0_react@18.2.0', 'node_modules', 'foo'],
      'foo',
      '1.0.0',
    );
    await expect(locateInstalled(project, 'foo', '1.0.0')).resolves.toBe(expected);
  });

  it('does not match a different version sharing the prefix (foo@1.0.0 vs foo@1.0.01)', async () => {
    const project = tmpProject();
    await writePkg(
      project,
      ['node_modules', '.pnpm', 'foo@1.0.01', 'node_modules', 'foo'],
      'foo',
      '1.0.01',
    );
    await expect(locateInstalled(project, 'foo', '1.0.0')).resolves.toBeNull();
  });

  it('finds a scoped package via pnpm @scope+pkg encoding', async () => {
    const project = tmpProject();
    const expected = await writePkg(
      project,
      ['node_modules', '.pnpm', '@scope+pkg@3.0.0', 'node_modules', '@scope', 'pkg'],
      '@scope/pkg',
      '3.0.0',
    );
    await expect(locateInstalled(project, '@scope/pkg', '3.0.0')).resolves.toBe(expected);
  });
});

describe('locateInstalled — nested fallback walk', () => {
  it('finds a version nested under another package when the hoisted copy differs', async () => {
    const project = tmpProject();
    await writePkg(project, ['node_modules', 'foo'], 'foo', '2.0.0');
    await writePkg(project, ['node_modules', 'parent'], 'parent', '1.0.0');
    const expected = await writePkg(
      project,
      ['node_modules', 'parent', 'node_modules', 'foo'],
      'foo',
      '1.0.0',
    );
    await expect(locateInstalled(project, 'foo', '1.0.0')).resolves.toBe(expected);
  });

  it('finds a package at the depth-4 node_modules level', async () => {
    const project = tmpProject();
    const segments = ['node_modules', 'a', 'node_modules', 'b', 'node_modules', 'c'];
    await writePkg(project, ['node_modules', 'a'], 'a', '1.0.0');
    await writePkg(project, ['node_modules', 'a', 'node_modules', 'b'], 'b', '1.0.0');
    await writePkg(project, segments, 'c', '1.0.0');
    const expected = await writePkg(project, [...segments, 'node_modules', 'foo'], 'foo', '1.0.0');
    await expect(locateInstalled(project, 'foo', '1.0.0')).resolves.toBe(expected);
  });

  it('stops at the depth cap (4 nested node_modules levels)', async () => {
    const project = tmpProject();
    const segments = ['node_modules'];
    for (const name of ['a', 'b', 'c', 'd']) {
      segments.push(name);
      await writePkg(project, segments, name, '1.0.0');
      segments.push('node_modules');
    }
    // .../node_modules(depth5)/foo — beyond the cap
    await writePkg(project, [...segments, 'foo'], 'foo', '1.0.0');
    await expect(locateInstalled(project, 'foo', '1.0.0')).resolves.toBeNull();
  });
});
