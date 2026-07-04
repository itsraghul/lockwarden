import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runSecrets } from '../../src/commands/secrets.js';
import { ExecError } from '../../src/exit.js';
import type { GlobalOptions } from '../../src/index.js';

/**
 * `secrets` is exercised in-process: runSecrets IS the command body, its
 * return value is the process exit code, and stdout is captured via spies
 * (console.log for human output, process.stdout.write for --json).
 *
 * The committed fixture must never contain contiguous secret-shaped literals
 * (GitHub push protection rejects them), so it carries __LW_FIXTURE_*__
 * placeholders. beforeAll copies the tree to a tmpdir and substitutes
 * runtime-assembled fake tokens; every scan targets that copy. Only AWS's
 * documented AKIAIOSFODNN7EXAMPLE and the jwt.io example JWT stay literal.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMITTED_FIXTURE = join(HERE, '..', 'fixtures', 'projects', 'secrets-fixture');

const FAKE_AKIA = 'AKIAIOSFODNN7EXAMPLE';
const FAKE_GHP = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const FAKE_SK_TEST = ['sk', 'test', '4eC39HqLyjWDarjtT1zdp7dc'].join('_');
const FAKE_ENTROPY = 'kJ8xQ2mZp7Rw4Vt6Ys1Bn3Ld5Fg0Hc';

const PLACEHOLDERS: Record<string, string> = {
  __LW_FIXTURE_GHP__: FAKE_GHP,
  __LW_FIXTURE_STRIPE_TEST__: FAKE_SK_TEST,
  __LW_FIXTURE_ENTROPY__: FAKE_ENTROPY,
};

/** Tmpdir copy of the fixture with placeholders replaced by live-shaped fakes. */
let fixture: string;

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'lockwarden-secrets-fixture-'));
  cpSync(COMMITTED_FIXTURE, fixture, { recursive: true });
  for (const rel of ['src/config.js', 'node_modules/dep-with-script/steal.js']) {
    const abs = join(fixture, rel);
    let text = readFileSync(abs, 'utf8');
    for (const [placeholder, token] of Object.entries(PLACEHOLDERS)) {
      text = text.replaceAll(placeholder, token);
    }
    writeFileSync(abs, text);
  }
});

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  stdout: string;
}

async function run(overrides: Partial<GlobalOptions> = {}): Promise<RunResult> {
  const chunks: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(`${args.join(' ')}\n`);
  });
  const writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
  try {
    const code = await runSecrets({
      json: false,
      sarif: false,
      ci: false,
      dir: [fixture],
      threshold: 'high',
      offline: false,
      ...overrides,
    });
    return { code, stdout: chunks.join('') };
  } finally {
    logSpy.mockRestore();
    writeSpy.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('secrets — exit-code matrix', () => {
  it('exits 1 at the default high threshold (AKIA + ghp_ present)', async () => {
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('AWS access key ID');
    expect(r.stdout).toContain('GitHub token');
  });

  it('exits 1 at --threshold med', async () => {
    const r = await run({ threshold: 'med' });
    expect(r.code).toBe(1);
  });

  it('exits 0 at --threshold critical: findings exist but stay below the bar', async () => {
    const r = await run({ threshold: 'critical' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('AWS access key ID'); // still reported, just not fatal
  });

  it('exits 0 on a clean directory', async () => {
    const clean = mkdtempSync(join(tmpdir(), 'lockwarden-secrets-clean-'));
    try {
      writeFileSync(join(clean, 'index.js'), "console.log('nothing to see');\n");
      const r = await run({ dir: [clean] });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('clean');
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });

  it('rejects with an exit-2 ExecError on a missing directory', async () => {
    const promise = run({ dir: [join(fixture, 'no-such-dir')] });
    await expect(promise).rejects.toBeInstanceOf(ExecError);
    await expect(promise).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe('secrets — --dir targeting and cwd default', () => {
  it('scans the cwd when no --dir is given', async () => {
    const previous = process.cwd();
    process.chdir(fixture);
    try {
      const r = await run({ dir: [] });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('src/config.js');
    } finally {
      process.chdir(previous);
    }
  });

  it('scans only the targeted --dir', async () => {
    const other = mkdtempSync(join(tmpdir(), 'lockwarden-secrets-target-'));
    try {
      mkdirSync(join(other, 'src'));
      writeFileSync(join(other, 'src', 'app.js'), `const auth = '${FAKE_GHP}';\n`);
      const r = await run({ dir: [other], json: true });
      const parsed = JSON.parse(r.stdout);
      expect(parsed.exitCode).toBe(1);
      expect(parsed.findings).toHaveLength(1);
      expect(parsed.findings[0].file).toBe('src/app.js');
      expect(parsed.findings[0].package).toBeUndefined();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('secrets — install-path scanning', () => {
  it('attributes a lifecycle-script finding to the owning package', async () => {
    const r = await run({ json: true });
    const parsed = JSON.parse(r.stdout);
    const ghpFinding = parsed.findings.find((f: { ruleId: string }) => f.ruleId === 'github-token');
    expect(ghpFinding).toMatchObject({
      file: 'node_modules/dep-with-script/steal.js',
      package: 'dep-with-script',
      severity: 'high',
    });
  });

  it('scans only install-path files of dependencies, never all of node_modules', async () => {
    const r = await run({ json: true });
    const parsed = JSON.parse(r.stdout);
    expect(parsed.scanned.packages).toBe(2); // dep-with-script + dep-clean
    expect(
      parsed.findings.filter((f: { package?: string }) => f.package === 'dep-clean'),
    ).toHaveLength(0);
  });
});

describe('secrets — --json output', () => {
  it('emits stable, masked machine-readable output', async () => {
    const r = await run({ json: true });
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.command).toBe('secrets');
    expect(parsed.exitCode).toBe(1);
    expect(parsed.scanned).toEqual({ files: 6, packages: 2 });
    expect(parsed).toMatchSnapshot(); // paths are fixture-relative, already normalized
  });

  it('never leaks a full secret, in any output mode', async () => {
    for (const overrides of [{}, { json: true }, { ci: true }] as Partial<GlobalOptions>[]) {
      const r = await run(overrides);
      expect(r.stdout).not.toContain(FAKE_AKIA);
      expect(r.stdout).not.toContain(FAKE_GHP);
      expect(r.stdout).not.toContain(FAKE_SK_TEST);
      expect(r.stdout).not.toContain(FAKE_ENTROPY);
    }
  });
});

describe('secrets — --ci output', () => {
  it('prints severity counts only, no file paths', async () => {
    const r = await run({ ci: true });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('2 high');
    expect(r.stdout).not.toContain('config.js');
  });
});
