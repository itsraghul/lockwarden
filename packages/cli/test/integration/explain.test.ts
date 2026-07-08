import { describe, expect, it } from 'vitest';
import { type ExplainReport, runExplain } from '../../src/commands/explain.js';
import { loadIncidents } from '../../src/data/index.js';
import type { GlobalOptions } from '../../src/index.js';
import { LAYER1_EXPLANATIONS, LAYER2_EXPLANATIONS } from '../../src/scoring/explanations.js';
import { WEIGHTS } from '../../src/scoring/weights.js';

/**
 * Weights assertions read the live WEIGHTS table and advisory assertions
 * derive from the vendored bundles — a corpus re-lock or incident release
 * must never churn this file.
 */

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

async function run(
  query: string | undefined,
  g: GlobalOptions = globals(),
): Promise<{ code: number; stdout: string }> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalLog = console.log;
  console.log = (...args: unknown[]): void => {
    chunks.push(`${args.map(String).join(' ')}\n`);
  };
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await runExplain(query, g);
    return { code, stdout: chunks.join('') };
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
}

describe('explain — listing and resolution', () => {
  it('no argument lists every family, exit 0', async () => {
    const r = await run(undefined);
    expect(r.code).toBe(0);
    for (const explanation of [...LAYER1_EXPLANATIONS, ...LAYER2_EXPLANATIONS]) {
      expect(r.stdout).toContain(explanation.id);
      expect(r.stdout).toContain(explanation.name);
    }
  });

  it('resolves family id, full codes, D-shorthand, and analyzer id to the same entry', async () => {
    const queries = [
      'LW001',
      'lw001-lifecycle',
      'LW001D-LIFECYCLE-INTRODUCED',
      'lifecycle-scripts',
    ];
    for (const query of queries) {
      const r = await run(query, globals({ json: true }));
      const parsed = JSON.parse(r.stdout) as ExplainReport;
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0]?.id).toBe('LW001');
    }
  });

  it('--json weights come from the live WEIGHTS table for every layer-1 family', async () => {
    const r = await run(undefined, globals({ json: true }));
    const parsed = JSON.parse(r.stdout) as ExplainReport;
    expect(parsed.command).toBe('explain');
    expect(parsed.exitCode).toBe(0);
    expect(parsed.entries).toHaveLength(LAYER1_EXPLANATIONS.length + LAYER2_EXPLANATIONS.length);
    for (const explanation of LAYER1_EXPLANATIONS) {
      const entry = parsed.entries.find((candidate) => candidate.id === explanation.id);
      expect(entry?.weights).toEqual(WEIGHTS[explanation.analyzer]);
      expect(entry?.layer).toBe(1);
    }
    for (const explanation of LAYER2_EXPLANATIONS) {
      const entry = parsed.entries.find((candidate) => candidate.id === explanation.id);
      expect(entry?.alwaysCritical).toBe(true);
      expect(entry?.layer).toBe(2);
    }
  });

  it('--ci prints the header lines only', async () => {
    const r = await run('LW001', globals({ ci: true }));
    expect(r.stdout).toContain('LW001');
    expect(r.stdout).not.toContain('what to do');
  });
});

describe('explain — dynamic layer-2 codes', () => {
  it('a full LW2-IOC code resolves the vendored bundle it points at', async () => {
    const bundle = [...loadIncidents().values()][0];
    expect(bundle).toBeDefined();
    if (bundle === undefined) return;
    const r = await run(`LW2-IOC-${bundle.id}`, globals({ json: true }));
    const parsed = JSON.parse(r.stdout) as ExplainReport;
    expect(parsed.entries[0]?.id).toBe('LW2-IOC');
    expect(parsed.entries[0]?.matched).toMatchObject({
      source: 'incident',
      id: bundle.id,
      summary: bundle.summary,
    });
  });

  it('the -FILE variant resolves to the same bundle', async () => {
    const bundle = [...loadIncidents().values()][0];
    if (bundle === undefined) return;
    const r = await run(`LW2-IOC-${bundle.id}-FILE`, globals({ json: true }));
    const parsed = JSON.parse(r.stdout) as ExplainReport;
    expect(parsed.entries[0]?.matched?.id).toBe(bundle.id);
  });

  it('an unknown advisory id still explains the family, without a matched block', async () => {
    const r = await run('LW2-OSV-MAL-0000-99999', globals({ json: true }));
    const parsed = JSON.parse(r.stdout) as ExplainReport;
    expect(parsed.entries[0]?.id).toBe('LW2-OSV');
    expect(parsed.entries[0]?.matched).toBeUndefined();
  });
});

describe('explain — errors', () => {
  it('an unknown code is exit 2 with the known-code hint', async () => {
    await expect(run('bogus')).rejects.toMatchObject({ exitCode: 2 });
    await expect(run('LW999')).rejects.toThrow(/unknown finding code/);
  });
});
