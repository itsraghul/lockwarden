/**
 * Advisory-data freshness: age math and the --max-advisory-age guard.
 * Advisory data ships vendored inside the package; its age is the age of
 * the installed lockwarden's data shipment. The guard is the user-side
 * dead-man's-switch for the refresh pipeline: if osv-refresh.yml silently
 * dies, ages grow and CI runs with the flag start failing loudly.
 */
import { advisoryFreshness } from '../data/index.ts';
import { ExecError } from '../exit.ts';

/**
 * Test-only clock override (ISO date). Exists so age-dependent tests and
 * fixtures stay deterministic; never documented user surface, never config.
 */
export function advisoryNow(): Date {
  const raw = process.env.LOCKWARDEN_NOW;
  if (raw !== undefined && raw !== '') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  return new Date();
}

/** Whole days between the stamp and now, UTC-midnight based, clamped ≥ 0. */
export function advisoryAgeDays(generatedAt: string, now: Date): number {
  const stamp = Date.parse(`${generatedAt}T00:00:00Z`);
  if (Number.isNaN(stamp)) return 0;
  const nowMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.floor((nowMidnight - stamp) / 86_400_000));
}

/** Parse --max-advisory-age: whole number of days ≥ 0, or ExecError (exit 2). */
export function parseMaxAdvisoryAge(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new ExecError(
      `invalid --max-advisory-age '${raw}'`,
      'pass a whole number of days ≥ 0 (0 = advisories must have been generated today, UTC)',
    );
  }
  return Number(raw);
}

/**
 * Enforce --max-advisory-age against the vendored OSV snapshot's
 * generatedAt (age > max fails; age == max passes). No-op when unset.
 */
export function enforceMaxAdvisoryAge(maxAdvisoryAge: string | undefined): void {
  const max = parseMaxAdvisoryAge(maxAdvisoryAge);
  if (max === undefined) return;
  const { osvGeneratedAt } = advisoryFreshness();
  const age = advisoryAgeDays(osvGeneratedAt, advisoryNow());
  if (age > max) {
    throw new ExecError(
      `vendored advisory data is ${age} days old (generated ${osvGeneratedAt}, --max-advisory-age ${max})`,
      'advisory data ships inside the lockwarden package — update it: npm i -g lockwarden@latest, or run via npx lockwarden@latest',
    );
  }
}
