import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecError } from '../../../src/exit.js';
import { detectLockfile, loadGraph, parseLockfileContent } from '../../../src/lockfile/detect.js';
import { fixtureDir } from './helpers.js';

const tempDirs: string[] = [];

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lockwarden-detect-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const NPM_LOCK = JSON.stringify({
  name: 'x',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: { '': { name: 'x', version: '1.0.0' } },
});
const PNPM_LOCK = "lockfileVersion: '9.0'\npackages: {}\nsnapshots: {}\n";
const YARN_CLASSIC_LOCK = '# yarn lockfile v1\n\nleft-pad@^1.3.0:\n  version "1.3.0"\n';
const YARN_BERRY_LOCK = [
  '__metadata:',
  '  version: 8',
  '',
  '"x@workspace:.":',
  '  version: 0.0.0-use.local',
  '  resolution: "x@workspace:."',
  '',
].join('\n');

describe('detectLockfile', () => {
  it('returns null when no lockfile exists', () => {
    const dir = tempProject({ 'package.json': '{}' });
    expect(detectLockfile(dir)).toBeNull();
  });

  it('detects each lockfile type on its own', () => {
    expect(detectLockfile(tempProject({ 'package-lock.json': NPM_LOCK }))?.type).toBe('npm');
    expect(detectLockfile(tempProject({ 'pnpm-lock.yaml': PNPM_LOCK }))?.type).toBe('pnpm');
    expect(detectLockfile(tempProject({ 'yarn.lock': YARN_CLASSIC_LOCK }))?.type).toBe(
      'yarn-classic',
    );
    expect(detectLockfile(tempProject({ 'yarn.lock': YARN_BERRY_LOCK }))?.type).toBe('yarn-berry');
  });

  it('prefers the lockfile matching the packageManager field and warns', () => {
    const dir = tempProject({
      'package.json': JSON.stringify({ packageManager: 'pnpm@9.1.0' }),
      'package-lock.json': NPM_LOCK,
      'pnpm-lock.yaml': PNPM_LOCK,
    });
    const detected = detectLockfile(dir);
    expect(detected?.type).toBe('pnpm');
    expect(detected?.path).toBe(join(dir, 'pnpm-lock.yaml'));
    expect(detected?.warning).toContain('multiple lockfiles');
    expect(detected?.warning).toContain('packageManager');
  });

  it('falls back to newest mtime when packageManager does not disambiguate', () => {
    const dir = tempProject({
      'package-lock.json': NPM_LOCK,
      'yarn.lock': YARN_CLASSIC_LOCK,
    });
    const old = new Date(Date.now() - 60_000);
    const fresh = new Date();
    utimesSync(join(dir, 'package-lock.json'), old, old);
    utimesSync(join(dir, 'yarn.lock'), fresh, fresh);
    const detected = detectLockfile(dir);
    expect(detected?.type).toBe('yarn-classic');
    expect(detected?.warning).toContain('most recently modified');
  });
});

describe('parseLockfileContent', () => {
  it('dispatches on the given type without touching the filesystem', () => {
    const graph = parseLockfileContent(YARN_CLASSIC_LOCK, 'yarn-classic', {
      lockfilePath: 'git:yarn.lock@abc123',
      rootManifest: { dependencies: { 'left-pad': '^1.3.0' } },
    });
    expect(graph.lockfileType).toBe('yarn-classic');
    expect(graph.lockfilePath).toBe('git:yarn.lock@abc123');
    expect(graph.packages.has('left-pad@1.3.0')).toBe(true);
  });

  it('wraps parser failures in ExecError (exit 2 semantics)', () => {
    expect(() =>
      parseLockfileContent('{ broken', 'npm', { lockfilePath: 'x/package-lock.json' }),
    ).toThrowError(ExecError);
  });
});

describe('loadGraph', () => {
  it('loads the npm-basic fixture end to end', () => {
    const graph = loadGraph(fixtureDir('npm-basic'));
    expect(graph.lockfileType).toBe('npm');
    expect(graph.packages.size).toBe(6);
    expect(graph.warnings).toEqual([]);
  });

  it('loads the pnpm-basic fixture end to end', () => {
    const graph = loadGraph(fixtureDir('pnpm-basic'));
    expect(graph.lockfileType).toBe('pnpm');
    expect(graph.packages.get('test-runner-lite@5.0.3')?.dev).toBe(true);
  });

  it('loads the yarn-basic fixture using package.json for root edges', () => {
    const graph = loadGraph(fixtureDir('yarn-basic'));
    expect(graph.lockfileType).toBe('yarn-classic');
    expect(graph.packages.get('test-runner-lite@5.0.3')?.dev).toBe(true);
    expect(graph.packages.get('@scope/util@2.3.1')?.dev).toBe(false);
  });

  it('throws ExecError with exit code 2 when no lockfile exists', () => {
    const dir = tempProject({ 'package.json': '{}' });
    try {
      loadGraph(dir);
      expect.unreachable('loadGraph should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ExecError);
      expect((err as ExecError).exitCode).toBe(2);
    }
  });

  it('throws ExecError when the lockfile is unparseable', () => {
    const dir = tempProject({ 'package-lock.json': 'not json at all {{{' });
    expect(() => loadGraph(dir)).toThrowError(ExecError);
  });

  it('surfaces the multi-lockfile warning on the graph', () => {
    const dir = tempProject({
      'package.json': JSON.stringify({ packageManager: 'npm@10.0.0' }),
      'package-lock.json': NPM_LOCK,
      'yarn.lock': YARN_CLASSIC_LOCK,
    });
    const graph = loadGraph(dir);
    expect(graph.lockfileType).toBe('npm');
    expect(graph.warnings.some((w) => w.includes('multiple lockfiles'))).toBe(true);
  });
});
