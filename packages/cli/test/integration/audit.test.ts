import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Dev-side ustar writer from the corpus harness (vitest resolves .ts imports).
import { writeTarGz } from '../../../../corpus/src/tar-write.ts';

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');
const PROJECTS = join(HERE, '..', 'fixtures', 'projects');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Every run gets an isolated tarball cache — no test touches ~/.lockwarden. */
function freshCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'lockwarden-cache-'));
}

async function run(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: '1',
        LOCKWARDEN_CACHE_DIR: env.LOCKWARDEN_CACHE_DIR ?? freshCacheDir(),
        ...env,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('audit — absolute mode, clean tree', () => {
  it('grades A and exits 0 with zero execution surface', async () => {
    const r = await run(['audit'], join(PROJECTS, 'audit-clean'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('grade A');
    expect(r.stdout).toContain('0 packages flagged of 2 analyzed');
  });

  it('runs under --offline (absolute mode is zero-network)', async () => {
    const r = await run(['--offline', 'audit'], join(PROJECTS, 'audit-clean'));
    expect(r.code).toBe(0);
  });

  it('exits 2 on an unparseable lockfile', async () => {
    const r = await run(['audit'], join(PROJECTS, 'corrupt'));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('lockwarden:');
  });
});

describe('audit — absolute mode, flagged tree', () => {
  const cwd = join(PROJECTS, 'audit-flagged');

  it('reports the postinstall (med) and binding.gyp (low) surface with grades', async () => {
    const r = await run(['audit'], cwd);
    expect(r.stdout).toContain('grade C'); // rollup: worst grade
    expect(r.stdout).toContain('with-post@1.0.0');
    expect(r.stdout).toContain('LW001-LIFECYCLE');
    expect(r.stdout).toContain('with-gyp@1.0.0');
    expect(r.stdout).toContain('LW002-BINDING-GYP');
    expect(r.stdout).toContain('grade B'); // with-gyp package grade
  });

  it('exit-code matrix across thresholds', async () => {
    expect((await run(['audit'], cwd)).code).toBe(0); // default: high
    expect((await run(['--threshold', 'high', 'audit'], cwd)).code).toBe(0);
    expect((await run(['--threshold', 'critical', 'audit'], cwd)).code).toBe(0);
    expect((await run(['--threshold', 'med', 'audit'], cwd)).code).toBe(1);
    expect((await run(['--threshold', 'low', 'audit'], cwd)).code).toBe(1);
    expect((await run(['--threshold', 'bogus', 'audit'], cwd)).code).toBe(2);
  });

  it('--ci prints the rollup + counts only', async () => {
    const r = await run(['--ci', 'audit'], cwd);
    expect(r.stdout).toContain('grade C');
    expect(r.stdout).toContain('med 1');
    expect(r.stdout).toContain('low 1');
    expect(r.stdout).not.toContain('LW001');
  });

  it('--json emits the stable AuditReport shape', async () => {
    const r = await run(['--json', 'audit'], cwd);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.command).toBe('audit');
    expect(parsed.mode).toBe('absolute');
    expect(parsed.rollup.grade).toBe('C');
    expect(parsed.rollup.packagesAnalyzed).toBe(2);
    expect(parsed.rollup.packagesFlagged).toBe(2);
    expect(parsed.rollup.counts.med).toBe(1);
    expect(parsed.rollup.counts.low).toBe(1);
    expect(parsed.packages).toHaveLength(2);
    const normalized = JSON.parse(r.stdout.replaceAll(cwd, '<fixture>'));
    expect(normalized).toMatchSnapshot();
  });

  it('--sarif emits SARIF 2.1.0 with the level mapping', async () => {
    const r = await run(['--sarif', 'audit'], cwd);
    expect(r.code).toBe(0);
    const sarif = JSON.parse(r.stdout.replaceAll(cwd, '<fixture>'));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].tool.driver.name).toBe('lockwarden');
    // med → note; the low binding-gyp finding is suppressed without --verbose
    const levels = sarif.runs[0].results.map((res: { level: string }) => res.level);
    expect(levels).toEqual(['note']);
    // toolVersion comes from package.json — pin it before snapshotting
    sarif.runs[0].tool.driver.version = '<version>';
    expect(sarif).toMatchSnapshot();
  });

  it('--sarif --verbose includes the low finding', async () => {
    const r = await run(['--sarif', 'audit', '--verbose'], cwd);
    const sarif = JSON.parse(r.stdout);
    expect(sarif.runs[0].results).toHaveLength(2);
  });
});

describe('audit — layer 2 known-bad overlay', () => {
  it('flags plain-crypto-js@1.0.0 critical from the vendored OSV seed, node_modules absent', async () => {
    const r = await run(['audit'], join(PROJECTS, 'audit-layer2'));
    expect(r.code).toBe(1); // critical ≥ default high threshold
    expect(r.stdout).toContain('grade F');
    expect(r.stdout).toContain('plain-crypto-js@1.0.0');
    expect(r.stdout).toContain('LW2-OSV-MAL-2026-0117');
    expect(r.stdout).toContain('LW2-IOC-axios-mar26');
    expect(r.stdout).toContain('not present in node_modules');
  });
});

describe('audit --diff', () => {
  let repo: string;
  let server: Server;

  beforeAll(async () => {
    // foo@1.0.0 — the PREVIOUS version: no lifecycle scripts.
    const tarball = writeTarGz([
      {
        path: 'package.json',
        data: JSON.stringify({ name: 'foo', version: '1.0.0', main: 'index.js' }),
      },
      { path: 'index.js', data: "'use strict';\nmodule.exports = () => 'foo';\n" },
    ]);
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;

    server = createServer((req, res) => {
      if (req.url === '/foo-1.0.0.tgz') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(tarball);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no server port');
    const tarballUrl = `http://127.0.0.1:${address.port}/foo-1.0.0.tgz`;

    repo = mkdtempSync(join(tmpdir(), 'lockwarden-diff-'));
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

    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'diff-project', version: '1.0.0', dependencies: { foo: '^1.0.0' } }),
    );
    const baseLockfile = JSON.stringify(
      {
        name: 'diff-project',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': {
            name: 'diff-project',
            version: '1.0.0',
            dependencies: { foo: '^1.0.0' },
          },
          'node_modules/foo': { version: '1.0.0', resolved: tarballUrl, integrity },
        },
      },
      null,
      2,
    );
    writeFileSync(join(repo, 'package-lock.json'), baseLockfile);
    await git('add', '-A');
    await git('commit', '-qm', 'base: foo@1.0.0');

    // Working tree moves to foo@1.0.1, which INTRODUCES a postinstall.
    writeFileSync(
      join(repo, 'package-lock.json'),
      JSON.stringify(
        {
          name: 'diff-project',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': {
              name: 'diff-project',
              version: '1.0.0',
              dependencies: { foo: '^1.0.0' },
            },
            'node_modules/foo': {
              version: '1.0.1',
              resolved: 'https://registry.npmjs.org/foo/-/foo-1.0.1.tgz',
              integrity:
                'sha512-fXyzAAA0aaaBBBbbbCCCcccDDDdddEEEeeeFFFfffGGGgggHHHhhhIIIiiiJJJjjjKKKkkkLLLlllMMAA==',
              hasInstallScript: true,
            },
          },
        },
        null,
        2,
      ),
    );
    const fooDir = join(repo, 'node_modules', 'foo');
    mkdirSync(fooDir, { recursive: true });
    writeFileSync(
      join(fooDir, 'package.json'),
      JSON.stringify({
        name: 'foo',
        version: '1.0.1',
        main: 'index.js',
        scripts: { postinstall: 'node evil.js' },
      }),
    );
    writeFileSync(join(fooDir, 'index.js'), "'use strict';\nmodule.exports = () => 'foo';\n");
    writeFileSync(join(fooDir, 'evil.js'), "'use strict';\nconsole.log('payload');\n");
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repo, { recursive: true, force: true });
  });

  it('delta-scores the introduced postinstall as critical (exit 1)', async () => {
    const r = await run(['audit', '--diff', 'HEAD'], repo);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('grade F');
    expect(r.stdout).toContain('foo@1.0.1');
    expect(r.stdout).toContain('LW001D-LIFECYCLE-INTRODUCED');
  });

  it('--offline with a COLD cache exits 2 on the required previous-tarball fetch', async () => {
    const r = await run(['--offline', 'audit', '--diff', 'HEAD'], repo, {
      LOCKWARDEN_CACHE_DIR: freshCacheDir(),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--offline is set but a network call');
  });

  it('--offline succeeds on a WARM cache (cache hits are allowed offline)', async () => {
    const cache = freshCacheDir();
    const warmup = await run(['audit', '--diff', 'HEAD'], repo, { LOCKWARDEN_CACHE_DIR: cache });
    expect(warmup.code).toBe(1);
    const r = await run(['--offline', 'audit', '--diff', 'HEAD'], repo, {
      LOCKWARDEN_CACHE_DIR: cache,
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('LW001D-LIFECYCLE-INTRODUCED');
  });
});
