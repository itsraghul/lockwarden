import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { advisoryFreshness, loadIncidents, loadOsvSnapshot } from '../../../src/data/index.js';

describe('advisoryFreshness', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads the OSV snapshot generatedAt from the wrapper', () => {
    const { osvGeneratedAt } = advisoryFreshness();
    expect(osvGeneratedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('newest incident is the lexical max of vendored bundle dates', () => {
    const { newestIncidentDate } = advisoryFreshness();
    // Incident-proof: compute the expected max from the bundles themselves.
    const expected = [...loadIncidents().values()]
      .map((b) => b.date)
      .sort()
      .at(-1);
    expect(newestIncidentDate).toBe(expected);
  });

  it('a LOCKWARDEN_INCIDENT_DIR overlay with a later date wins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lockwarden-incidents-'));
    await writeFile(
      join(dir, 'test-future.json'),
      JSON.stringify({
        id: 'test-future',
        name: 'Test future incident',
        date: '2099-01-01',
        summary: 'test overlay',
        packages: [{ name: 'evil-pkg', versions: ['1.0.0'] }],
      }),
    );
    vi.stubEnv('LOCKWARDEN_INCIDENT_DIR', dir);
    expect(advisoryFreshness().newestIncidentDate).toBe('2099-01-01');
  });
});

describe('loadOsvSnapshot (wrapper migration)', () => {
  it('still returns the entries array with the seed ids', () => {
    const entries = loadOsvSnapshot();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((e) => e.id)).toContain('MAL-2026-0117');
  });
});
