import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type DriftOptions, runDrift } from '../../src/commands/drift.js';
import { ExecError } from '../../src/exit.js';
import type { GlobalOptions } from '../../src/index.js';

/**
 * drift is exercised in-process (runDrift) rather than by spawning
 * dist/index.js: command wiring in src/index.ts lands separately. The temp
 * git repos are real — same pattern as the check --history integration tests.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test',
};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: GIT_ENV });
}

const repos: string[] = [];
afterEach(() => {
  while (repos.length > 0) {
    const repo = repos.pop();
    if (repo !== undefined) rmSync(repo, { recursive: true, force: true });
  }
});

/** Init a repo on branch `main` with `files` committed as the base state. */
function initRepo(files: Record<string, string>): string {
  // realpath: on macOS tmpdir() is a symlink (/var → /private/var) and git
  // reports the resolved toplevel, which would break relative-path math.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'lockwarden-drift-')));
  repos.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(repo, name), content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  return repo;
}

function globals(overrides: Partial<GlobalOptions> = {}): GlobalOptions {
  return {
    json: false,
    sarif: false,
    ci: false,
    dir: [],
    threshold: 'high',
    offline: false,
    ...overrides,
  };
}

interface RunResult {
  code: number;
  out: string;
}

/** Run drift in-process, capturing everything written to stdout. */
async function drive(
  repo: string,
  options: DriftOptions = {},
  globalOverrides: Partial<GlobalOptions> = {},
): Promise<RunResult> {
  // Capture BOTH channels: printJson writes to process.stdout directly,
  // human rendering goes through console.log (which vitest intercepts).
  let out = '';
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalLog = console.log.bind(console);
  process.stdout.write = ((chunk: unknown): boolean => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]): void => {
    out += `${args.map(String).join(' ')}\n`;
  };
  try {
    const code = await runDrift(options, globals({ dir: [repo], ...globalOverrides }));
    return { code, out };
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
}

/* ------------------------------- fixtures ------------------------------- */

interface LockEntry {
  version: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
}

function lockJson(rootDeps: Record<string, string>, entries: Record<string, LockEntry>): string {
  const packages: Record<string, unknown> = {
    '': { name: 'drift-fixture', version: '1.0.0', dependencies: rootDeps },
  };
  for (const [name, entry] of Object.entries(entries)) {
    packages[`node_modules/${name}`] = entry;
  }
  return JSON.stringify(
    { name: 'drift-fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages },
    null,
    2,
  );
}

function manifestJson(deps: Record<string, string>): string {
  return JSON.stringify(
    { name: 'drift-fixture', version: '1.0.0', private: true, dependencies: deps },
    null,
    2,
  );
}

const REGISTRY = 'https://registry.npmjs.org';

function entry(name: string, version: string, extra: Partial<LockEntry> = {}): LockEntry {
  return {
    version,
    resolved: `${REGISTRY}/${name}/-/${name}-${version}.tgz`,
    integrity: `sha512-${name}-${version}-AAAA==`,
    ...extra,
  };
}

const BASE_DEPS = { 'left-pad': '^1.3.0', 'safe-logger': '^1.0.0' };

function baseEntries(): Record<string, LockEntry> {
  return {
    'left-pad': entry('left-pad', '1.3.0'),
    'safe-logger': entry('safe-logger', '1.0.2', { dependencies: { 'ansi-tone': '^2.0.0' } }),
    'ansi-tone': entry('ansi-tone', '2.1.0'),
  };
}

function baseFiles(): Record<string, string> {
  return {
    'package.json': manifestJson(BASE_DEPS),
    'package-lock.json': lockJson(BASE_DEPS, baseEntries()),
  };
}

/* --------------------------------- tests -------------------------------- */

describe('drift — integrity-swap', () => {
  it('flags a flipped integrity for an unchanged version and exits 1', async () => {
    const repo = initRepo(baseFiles());
    const tampered = baseEntries();
    tampered['left-pad'] = entry('left-pad', '1.3.0');
    tampered['left-pad'].integrity = 'sha512-TAMPERED-0000==';
    writeFileSync(join(repo, 'package-lock.json'), lockJson(BASE_DEPS, tampered));

    const r = await drive(repo);
    expect(r.code).toBe(1);
    expect(r.out).toContain('integrity-swap');
    expect(r.out).toContain('left-pad@1.3.0');
    expect(r.out).toContain('critical');
  });
});

describe('drift — unexplained-version', () => {
  it('flags a lockfile-only bump of a direct dep outside its unchanged range', async () => {
    const repo = initRepo(baseFiles());
    const tampered = baseEntries();
    tampered['left-pad'] = entry('left-pad', '2.0.0'); // package.json still ^1.3.0
    writeFileSync(join(repo, 'package-lock.json'), lockJson(BASE_DEPS, tampered));

    const r = await drive(repo);
    expect(r.code).toBe(1);
    expect(r.out).toContain('unexplained-version');
    expect(r.out).toContain('left-pad@2.0.0');
    expect(r.out).toContain('^1.3.0');
  });

  it('does NOT flag a bump explained by a package.json range change', async () => {
    const repo = initRepo(baseFiles());
    const bumpedDeps = { ...BASE_DEPS, 'left-pad': '^2.0.0' };
    const bumped = baseEntries();
    bumped['left-pad'] = entry('left-pad', '2.0.0');
    writeFileSync(join(repo, 'package.json'), manifestJson(bumpedDeps));
    writeFileSync(join(repo, 'package-lock.json'), lockJson(bumpedDeps, bumped));

    const r = await drive(repo);
    expect(r.code).toBe(0);
    expect(r.out).toContain('clean');
    expect(r.out).not.toContain('unexplained-version');
  });
});

describe('drift — resolved-url-move', () => {
  it('flags a tarball host move for an unchanged version and exits 1', async () => {
    const repo = initRepo(baseFiles());
    const tampered = baseEntries();
    tampered['left-pad'] = {
      ...entry('left-pad', '1.3.0'),
      resolved: 'https://evil.example.com/left-pad/-/left-pad-1.3.0.tgz',
    };
    writeFileSync(join(repo, 'package-lock.json'), lockJson(BASE_DEPS, tampered));

    const r = await drive(repo);
    expect(r.code).toBe(1);
    expect(r.out).toContain('resolved-url-move');
    expect(r.out).toContain('registry.npmjs.org → evil.example.com');
  });
});

describe('drift — patch-introduced-dep', () => {
  it('flags a new package arriving via a patch bump of an existing dep', async () => {
    const repo = initRepo(baseFiles());
    const bumped = baseEntries();
    bumped['safe-logger'] = entry('safe-logger', '1.0.3', {
      dependencies: { 'ansi-tone': '^2.0.0', 'new-dep': '^1.0.0' },
    });
    bumped['new-dep'] = entry('new-dep', '1.0.0');
    writeFileSync(join(repo, 'package-lock.json'), lockJson(BASE_DEPS, bumped));

    const r = await drive(repo);
    expect(r.code).toBe(1);
    expect(r.out).toContain('patch-introduced-dep');
    expect(r.out).toContain('new-dep@1.0.0');
    expect(r.out).toContain('safe-logger 1.0.2 → 1.0.3');
    // The in-range patch bump itself is NOT an unexplained version.
    expect(r.out).not.toContain('unexplained-version');
  });
});

describe('drift — clean and error paths', () => {
  it('exits 0 with clean output when nothing changed', async () => {
    const repo = initRepo(baseFiles());
    const r = await drive(repo);
    expect(r.code).toBe(0);
    expect(r.out).toContain('clean');
    expect(r.out).toContain('provenance is informational only');
  });

  it('prints counts only under --ci (no provenance note)', async () => {
    const repo = initRepo(baseFiles());
    const r = await drive(repo, {}, { ci: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain('no findings');
    expect(r.out).not.toContain('provenance');
  });

  it('exits 2 (ExecError) on a missing base ref', async () => {
    const repo = initRepo(baseFiles());
    const err = await drive(repo, { base: 'no-such-ref' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).exitCode).toBe(2);
    expect((err as ExecError).message).toContain("not found at ref 'no-such-ref'");
  });

  it('threshold gates the exit code: med findings pass at high, fail at med', async () => {
    const repo = initRepo(baseFiles());
    const tampered = baseEntries();
    // Same host, different path, same version → med path-only url move.
    tampered['left-pad'] = {
      ...entry('left-pad', '1.3.0'),
      resolved: `${REGISTRY}/left-pad/-/left-pad-1.3.0-rebuilt.tgz`,
    };
    writeFileSync(join(repo, 'package-lock.json'), lockJson(BASE_DEPS, tampered));

    const atHigh = await drive(repo);
    expect(atHigh.code).toBe(0);
    expect(atHigh.out).toContain('resolved-url-move');

    const atMed = await drive(repo, {}, { threshold: 'med' });
    expect(atMed.code).toBe(1);
  });
});

describe('drift --json', () => {
  it('emits the stable machine-readable shape', async () => {
    const repo = initRepo(baseFiles());
    const tampered = baseEntries();
    tampered['left-pad'] = entry('left-pad', '1.3.0');
    tampered['left-pad'].integrity = 'sha512-TAMPERED-0000==';
    writeFileSync(join(repo, 'package-lock.json'), lockJson(BASE_DEPS, tampered));

    const r = await drive(repo, {}, { json: true });
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out) as {
      command: string;
      base: string;
      findings: Array<{ kind: string }>;
      exitCode: number;
    };
    expect(parsed.command).toBe('drift');
    expect(parsed.base).toBe('main');
    expect(parsed.exitCode).toBe(1);
    expect(parsed.findings.map((f) => f.kind)).toContain('integrity-swap');

    const normalized = JSON.parse(r.out.replaceAll(repo, '<repo>'));
    expect(normalized).toMatchSnapshot();
  });
});
