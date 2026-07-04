import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type ScanOptions, runScan } from '../../src/commands/scan.js';
import { ExecError } from '../../src/exit.js';
import type { GlobalOptions } from '../../src/index.js';

/**
 * scan is exercised in-process (runScan is the whole command; index.ts only
 * wires argv). Exit-2 paths are asserted via ExecError.exitCode — exactly
 * what the CLI entrypoint maps to process.exitCode.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', 'fixtures');
const ARTIFACTS = path.join(FIXTURES, 'artifacts');

const artifact = (name: string): string => path.join(ARTIFACTS, name);

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
  stdout: string;
}

async function run(
  artifactPath: string | undefined,
  options: ScanOptions = {},
  g: GlobalOptions = globals(),
  env: Record<string, string> = {},
): Promise<RunResult> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const savedEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  // Human-mode rendering goes through console.log (which vitest intercepts
  // before it reaches process.stdout), machine output through stdout.write —
  // capture both.
  const originalLog = console.log;
  console.log = (...args: unknown[]): void => {
    chunks.push(`${args.map(String).join(' ')}\n`);
  };
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await runScan(artifactPath, options, g);
    return { code, stdout: chunks.join('') };
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('scan — clean artifacts', () => {
  it('grades a clean vendored tree A and exits 0 (tgz)', async () => {
    const r = await run(artifact('app-clean.tgz'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('grade A');
    expect(r.stdout).toContain('0 packages flagged of 3 analyzed');
    expect(r.stdout).toContain('(tgz) — 3 embedded package roots');
  });

  it('works fully offline (scan never touches the network)', async () => {
    const r = await run(artifact('app-clean.tgz'), {}, globals({ offline: true }));
    expect(r.code).toBe(0);
  });

  it('scans the same tree from a zip (stored + deflated entries)', async () => {
    const r = await run(artifact('app.zip'), {}, globals({ json: true }));
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.command).toBe('scan');
    expect(parsed.artifact.kind).toBe('zip');
    expect(parsed.rollup.grade).toBe('A');
    expect(parsed.rollup.packagesAnalyzed).toBe(3);
    expect(parsed.packages).toEqual([]);
  });

  it('scans a directory, walking INTO node_modules (unlike audit source walks)', async () => {
    const dir = path.join(FIXTURES, 'projects', 'audit-flagged');
    const r = await run(dir, {}, globals({ threshold: 'med' }));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('(directory)');
    expect(r.stdout).toContain('with-post@1.0.0');
    expect(r.stdout).toContain('LW001-LIFECYCLE');
    expect(r.stdout).toContain('with-gyp@1.0.0');
  });
});

describe('scan — baked-in postinstall (tampered dep pre-baked in node_modules)', () => {
  const baked = artifact('app-baked-postinstall.tgz');

  it('flags the vendored postinstall and obfuscated install-path file', async () => {
    const r = await run(baked, {}, globals({ threshold: 'med' }));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('grade C');
    expect(r.stdout).toContain('evil-thing@1.0.1');
    expect(r.stdout).toContain('(package/node_modules/evil-thing)');
    expect(r.stdout).toContain('LW001-LIFECYCLE');
    expect(r.stdout).toContain('LW007-OBFUSCATION');
  });

  it('exit-code matrix across thresholds', async () => {
    expect((await run(baked)).code).toBe(0); // default: high; findings are med
    expect((await run(baked, {}, globals({ threshold: 'critical' }))).code).toBe(0);
    expect((await run(baked, {}, globals({ threshold: 'med' }))).code).toBe(1);
    expect((await run(baked, {}, globals({ threshold: 'low' }))).code).toBe(1);
    await expect(run(baked, {}, globals({ threshold: 'bogus' }))).rejects.toMatchObject({
      exitCode: 2,
    });
  });

  it('--ci prints the rollup + counts only', async () => {
    const r = await run(baked, {}, globals({ ci: true }));
    expect(r.stdout).toContain('grade C');
    expect(r.stdout).toContain('med 2');
    expect(r.stdout).not.toContain('LW001');
  });

  it('--json emits the stable ScanReport shape', async () => {
    const r = await run(baked, {}, globals({ json: true }));
    const parsed = JSON.parse(r.stdout);
    expect(parsed.command).toBe('scan');
    expect(parsed.artifact.kind).toBe('tgz');
    expect(parsed.artifact.roots).toBe(2);
    expect(parsed.rollup.grade).toBe('C');
    expect(parsed.rollup.counts.med).toBe(2);
    expect(parsed.packages).toHaveLength(1);
    expect(parsed.packages[0].root).toBe('package/node_modules/evil-thing');
    const normalized = JSON.parse(r.stdout.replaceAll(ARTIFACTS, '<fixtures>'));
    expect(normalized).toMatchSnapshot();
  });

  it('--sarif emits SARIF 2.1.0 with artifact uri + embedded-root logical locations', async () => {
    const r = await run(baked, {}, globals({ sarif: true }));
    const sarif = JSON.parse(r.stdout.replaceAll(ARTIFACTS, '<fixtures>'));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].tool.driver.name).toBe('lockwarden');
    const results = sarif.runs[0].results;
    expect(results.map((res: { level: string }) => res.level)).toEqual(['note', 'note']);
    expect(results[0].locations[0].physicalLocation.artifactLocation.uri).toBe(
      '<fixtures>/app-baked-postinstall.tgz',
    );
    expect(results[0].locations[0].logicalLocations[0].fullyQualifiedName).toBe(
      'package/node_modules/evil-thing:evil-thing@1.0.1',
    );
    sarif.runs[0].tool.driver.version = '<version>';
    expect(sarif).toMatchSnapshot();
  });
});

describe('scan — docker-save layout', () => {
  const image = artifact('docker-save.tar');

  it('applies later-layer-wins and flags the Layer-2 known-bad package', async () => {
    const r = await run(image);
    expect(r.code).toBe(1); // critical ≥ default high threshold
    expect(r.stdout).toContain('grade F');
    expect(r.stdout).toContain('plain-crypto-js@1.0.0');
    expect(r.stdout).toContain('LW2-OSV-MAL-2026-0117');
    expect(r.stdout).toContain('LW2-IOC-axios-mar26');
    // layer 2 REPLACED x's package.json without the postinstall — the
    // shadowed lifecycle script must NOT be flagged.
    expect(r.stdout).not.toContain('LW001');
    expect(r.stdout).not.toContain('x@1.0.0');
  });

  it('reports the docker-save kind and both discovered roots', async () => {
    const r = await run(image, {}, globals({ json: true }));
    const parsed = JSON.parse(r.stdout);
    expect(parsed.artifact.kind).toBe('docker-save');
    expect(parsed.rollup.packagesAnalyzed).toBe(2);
    expect(parsed.packages.map((p: { key: string }) => p.key)).toEqual(['plain-crypto-js@1.0.0']);
  });
});

describe('scan — file IOC matching (LOCKWARDEN_INCIDENT_DIR)', () => {
  it('synthesizes a critical LW2-IOC-<incident>-FILE finding on a sha256 match', async () => {
    const r = await run(artifact('app-ioc.tgz'), {}, globals(), {
      LOCKWARDEN_INCIDENT_DIR: path.join(FIXTURES, 'incidents'),
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('grade F');
    expect(r.stdout).toContain('iocpkg@1.0.0');
    expect(r.stdout).toContain('LW2-IOC-scan-ioc-test-FILE');
    expect(r.stdout).toContain('payload.js');
  });

  it('is clean without the staged bundle (hash index empty)', async () => {
    const r = await run(artifact('app-ioc.tgz'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('grade A');
  });
});

describe('scan — execution errors (exit 2)', () => {
  it('missing artifact path', async () => {
    await expect(run(artifact('does-not-exist.tgz'))).rejects.toMatchObject({ exitCode: 2 });
    await expect(run(artifact('does-not-exist.tgz'))).rejects.toThrow(/artifact not found/);
  });

  it('no artifact and no --image', async () => {
    await expect(run(undefined)).rejects.toMatchObject({ exitCode: 2 });
    await expect(run(undefined)).rejects.toThrow(/nothing to scan/);
  });

  it('both an artifact path and --image', async () => {
    await expect(run(artifact('app-clean.tgz'), { image: 'x:latest' })).rejects.toThrow(/not both/);
  });

  it('unrecognized artifact format', async () => {
    const notArchive = path.join(FIXTURES, 'incidents', 'scan-ioc-test.json');
    await expect(run(notArchive)).rejects.toMatchObject({ exitCode: 2 });
    await expect(run(notArchive)).rejects.toThrow(/unrecognized artifact format/);
  });

  it('--image when the docker binary is missing gives exit 2 and a hint', async () => {
    const attempt = run(undefined, { image: 'busybox:latest' }, globals(), {
      PATH: '/var/empty',
    });
    await expect(attempt).rejects.toBeInstanceOf(ExecError);
    const err = await run(undefined, { image: 'busybox:latest' }, globals(), {
      PATH: '/var/empty',
    }).catch((e: ExecError) => e);
    expect(err).toBeInstanceOf(ExecError);
    expect((err as ExecError).exitCode).toBe(2);
    expect((err as ExecError).message).toContain('docker binary not found');
    expect((err as ExecError).hint).toContain('docker save busybox:latest -o image.tar');
  });
});
