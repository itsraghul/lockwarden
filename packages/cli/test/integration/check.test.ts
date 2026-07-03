import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');
const PROJECTS = join(HERE, '..', 'fixtures', 'projects');
const INCIDENT_DIR = join(HERE, '..', 'fixtures', 'incidents');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[], cwd: string, env: Record<string, string> = {}): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('check — exit-code matrix', () => {
  it('exits 1 when the package is in the resolved tree', async () => {
    const r = await run(['check', 'evil-pkg@1.2.3'], join(PROJECTS, 'hit-transitive'));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('evil-pkg@1.2.3');
  });

  it('exits 0 when the package is absent', async () => {
    const r = await run(['check', 'definitely-not-here@1.0.0'], join(PROJECTS, 'hit-transitive'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('clean');
  });

  it('exits 2 on an unparseable lockfile', async () => {
    const r = await run(['check', 'anything@1.0.0'], join(PROJECTS, 'corrupt'));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('lockwarden:');
  });

  it('exits 2 when given nothing to check', async () => {
    const r = await run(['check'], join(PROJECTS, 'hit-transitive'));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('nothing to check');
  });
});

describe('check — transitive path reporting', () => {
  it('reports every path by which the package enters the tree', async () => {
    const r = await run(['check', 'evil-pkg@1.2.3'], join(PROJECTS, 'hit-transitive'));
    expect(r.stdout).toContain('app-lib');
    expect(r.stdout).toContain('nested-lib');
    const traces = r.stdout.split('\n').filter((l) => l.includes('→'));
    expect(traces.length).toBeGreaterThanOrEqual(2);
  });

  it('matches all resolved versions on a bare name query', async () => {
    const r = await run(['check', 'evil-pkg'], join(PROJECTS, 'hit-transitive'));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('evil-pkg@1.2.3');
    expect(r.stdout).toContain('evil-pkg@2.0.0');
  });

  it('matches semver ranges without matching versions outside them', async () => {
    const r = await run(['check', 'evil-pkg@^1.0.0'], join(PROJECTS, 'hit-transitive'));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('evil-pkg@1.2.3');
    expect(r.stdout).not.toContain('evil-pkg@2.0.0');
  });
});

describe('check --json', () => {
  it('emits stable machine-readable output', async () => {
    const cwd = join(PROJECTS, 'hit-transitive');
    const r = await run(['--json', 'check', 'evil-pkg@1.2.3'], cwd);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.command).toBe('check');
    expect(parsed.hit).toBe(true);
    expect(parsed.exitCode).toBe(1);
    const normalized = JSON.parse(r.stdout.replaceAll(cwd, '<fixture>'));
    expect(normalized).toMatchSnapshot();
  });
});

describe('check --incident', () => {
  it('exits 1 when a bundle package is resolved in the tree', async () => {
    const r = await run(['check', '--incident', 'test-evil-pkg'], join(PROJECTS, 'hit-transitive'), {
      LOCKWARDEN_INCIDENT_DIR: INCIDENT_DIR,
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('Test fixture incident');
    expect(r.stdout).toContain('evil-pkg@1.2.3');
  });

  it('exits 0 for a vendored incident that does not touch the tree', async () => {
    const r = await run(['check', '--incident', 'node-ipc-may26'], join(PROJECTS, 'npm-basic'));
    expect(r.code).toBe(0);
  });

  it('exits 2 on an unknown incident id and lists known ids', async () => {
    const r = await run(['check', '--incident', 'no-such-incident'], join(PROJECTS, 'npm-basic'));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('node-ipc-may26');
  });
});

describe('check --history', () => {
  let repo: string;

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'lockwarden-history-'));
    const git = async (...args: string[]) =>
      execFileAsync('git', args, {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@test',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@test',
        },
      });
    await git('init', '-q');

    const hit = join(PROJECTS, 'hit-transitive');
    const clean = join(PROJECTS, 'npm-basic');
    // commit 1: clean tree
    cpSync(join(clean, 'package.json'), join(repo, 'package.json'));
    const cleanLock = readFileSync(join(clean, 'package-lock.json'), 'utf8');
    writeFileSync(join(repo, 'package-lock.json'), cleanLock);
    await git('add', '-A');
    await git('commit', '-qm', 'clean');
    // commit 2: evil-pkg enters
    cpSync(join(hit, 'package.json'), join(repo, 'package.json'));
    cpSync(join(hit, 'package-lock.json'), join(repo, 'package-lock.json'));
    await git('add', '-A');
    await git('commit', '-qm', 'add evil-pkg');
    // commit 3: evil-pkg removed again
    writeFileSync(join(repo, 'package-lock.json'), cleanLock);
    await git('add', '-A');
    await git('commit', '-qm', 'remove evil-pkg');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reports the exposure window and exits 1', async () => {
    const r = await run(['check', 'evil-pkg', '--history'], repo);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('EXPOSED');
    expect(r.stdout).toContain('1.2.3');
    expect(r.stdout).not.toContain('still present');
  });

  it('exits 0 for a package that never appeared', async () => {
    const r = await run(['check', 'never-here', '--history'], repo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('never appeared');
  });
});
