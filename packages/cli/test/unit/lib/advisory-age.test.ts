import { afterEach, describe, expect, it, vi } from 'vitest';
import { advisoryFreshness } from '../../../src/data/index.js';
import { ExecError } from '../../../src/exit.js';
import {
  advisoryAgeDays,
  advisoryNow,
  enforceMaxAdvisoryAge,
  parseMaxAdvisoryAge,
} from '../../../src/lib/advisory-age.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseMaxAdvisoryAge', () => {
  it('accepts whole numbers of days including 0', () => {
    expect(parseMaxAdvisoryAge('0')).toBe(0);
    expect(parseMaxAdvisoryAge('30')).toBe(30);
    expect(parseMaxAdvisoryAge(undefined)).toBeUndefined();
  });

  it('rejects non-integers with ExecError (exit 2)', () => {
    for (const bad of ['abc', '-1', '2.5', '', '30 days']) {
      expect(() => parseMaxAdvisoryAge(bad)).toThrow(ExecError);
    }
  });
});

describe('advisoryAgeDays', () => {
  it('computes whole UTC days', () => {
    expect(advisoryAgeDays('2026-07-01', new Date('2026-07-08T12:00:00Z'))).toBe(7);
    expect(advisoryAgeDays('2026-07-01', new Date('2026-07-01T23:59:59Z'))).toBe(0);
    // Any time on the next UTC day is 1 day old.
    expect(advisoryAgeDays('2026-07-01', new Date('2026-07-02T00:00:01Z'))).toBe(1);
  });

  it('clamps future stamps and unparseable dates to 0', () => {
    expect(advisoryAgeDays('2099-01-01', new Date('2026-07-08T00:00:00Z'))).toBe(0);
    expect(advisoryAgeDays('not-a-date', new Date('2026-07-08T00:00:00Z'))).toBe(0);
  });
});

describe('advisoryNow', () => {
  it('honors the LOCKWARDEN_NOW test override', () => {
    vi.stubEnv('LOCKWARDEN_NOW', '2030-05-05');
    expect(advisoryNow().toISOString()).toBe('2030-05-05T00:00:00.000Z');
  });

  it('falls back to wall clock on garbage', () => {
    vi.stubEnv('LOCKWARDEN_NOW', 'garbage');
    expect(Math.abs(advisoryNow().getTime() - Date.now())).toBeLessThan(5000);
  });
});

describe('enforceMaxAdvisoryAge', () => {
  it('is a no-op when the flag is unset', () => {
    vi.stubEnv('LOCKWARDEN_NOW', '2099-01-01');
    expect(() => enforceMaxAdvisoryAge(undefined)).not.toThrow();
  });

  it('throws ExecError when the vendored data is older than the limit', () => {
    vi.stubEnv('LOCKWARDEN_NOW', '2099-01-01');
    expect(() => enforceMaxAdvisoryAge('30')).toThrow(/days old/);
  });

  it('age == max passes (boundary)', () => {
    // Refresh-proof: derive "7 days after the vendored stamp" from the data
    // itself, so weekly OSV refreshes never break this boundary check.
    const { osvGeneratedAt } = advisoryFreshness();
    const sevenDaysLater = new Date(Date.parse(`${osvGeneratedAt}T00:00:00Z`) + 7 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    vi.stubEnv('LOCKWARDEN_NOW', sevenDaysLater);
    expect(() => enforceMaxAdvisoryAge('7')).not.toThrow();
    expect(() => enforceMaxAdvisoryAge('6')).toThrow(ExecError);
  });
});
