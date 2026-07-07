import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type IncidentsReport, runIncidents } from '../../src/commands/incidents.js';
import { loadIncidents, osvSnapshotInfo, vendoredIncidentIds } from '../../src/data/index.js';
import type { GlobalOptions } from '../../src/index.js';

/**
 * Expectations are DERIVED from the vendored data, never hardcoded — incident
 * releases and weekly OSV refreshes must not churn this file (same rule as
 * the advisory-freshness tests; see MEMORY.md). No snapshots for the same
 * reason: an incident-bundle release would break required CI on its own PR.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INCIDENT_FIXTURES = path.resolve(HERE, '..', 'fixtures', 'incidents');

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
  const originalLog = console.log;
  console.log = (...args: unknown[]): void => {
    chunks.push(`${args.map(String).join(' ')}\n`);
  };
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await runIncidents(g);
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

describe('incidents — vendored listing', () => {
  it('lists every vendored bundle, newest first, exit 0', async () => {
    const vendored = [...loadIncidents().values()];
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${vendored.length} incident bundle`);
    for (const bundle of vendored) {
      expect(r.stdout).toContain(bundle.id);
      expect(r.stdout).toContain(`npx lockwarden check --incident ${bundle.id}`);
    }
    // Newest first: ids appear in descending-date order.
    const sorted = [...vendored].sort(
      (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
    );
    const positions = sorted.map((bundle) => r.stdout.indexOf(`  ${bundle.id} — `));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('--json emits the stable IncidentsReport shape, derived from the vendored data', async () => {
    const vendored = loadIncidents();
    const osv = osvSnapshotInfo();
    const r = await run(globals({ json: true }));
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as IncidentsReport;
    expect(parsed.command).toBe('incidents');
    expect(parsed.exitCode).toBe(0);
    expect(parsed.osv).toEqual(osv);
    expect(parsed.incidents).toHaveLength(vendored.size);
    for (const listing of parsed.incidents) {
      const bundle = vendored.get(listing.id);
      expect(bundle).toBeDefined();
      if (bundle === undefined) continue;
      expect(listing.name).toBe(bundle.name);
      expect(listing.date).toBe(bundle.date);
      expect(listing.summary).toBe(bundle.summary);
      expect(listing.packages).toBe(bundle.packages.length);
      expect(listing.fileIocs).toBe(bundle.fileIocs?.length ?? 0);
      expect(listing.local).toBeUndefined(); // vendored, not overlay
    }
  });

  it('--ci prints the summary line only', async () => {
    const r = await run(globals({ ci: true }));
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(r.stdout).toContain('OSV snapshot');
    expect(r.stdout).not.toContain('npx lockwarden check');
  });
});

describe('incidents — LOCKWARDEN_INCIDENT_DIR overlays', () => {
  it('marks staged bundles as local; vendored ones stay unmarked', async () => {
    const r = await run(globals({ json: true }), { LOCKWARDEN_INCIDENT_DIR: INCIDENT_FIXTURES });
    const parsed = JSON.parse(r.stdout) as IncidentsReport;
    const staged = parsed.incidents.find((incident) => incident.id === 'scan-ioc-test');
    expect(staged).toBeDefined();
    expect(staged?.local).toBe(true);
    expect(staged?.fileIocs).toBe(1);
    // `local` marks exactly the ids not shipped in this build.
    const vendored = vendoredIncidentIds();
    for (const incident of parsed.incidents) {
      expect(incident.local === true).toBe(!vendored.has(incident.id));
    }

    const human = await run(globals(), { LOCKWARDEN_INCIDENT_DIR: INCIDENT_FIXTURES });
    expect(human.stdout).toContain('[local overlay]');
  });

  it('a malformed overlay bundle is exit 2 with a readable message', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lockwarden-incidents-'));
    writeFileSync(path.join(dir, 'broken.json'), '{not json', 'utf8');
    const attempt = run(globals(), { LOCKWARDEN_INCIDENT_DIR: dir });
    await expect(attempt).rejects.toMatchObject({ exitCode: 2 });
    await expect(run(globals(), { LOCKWARDEN_INCIDENT_DIR: dir })).rejects.toThrow(
      /LOCKWARDEN_INCIDENT_DIR/,
    );
  });
});
