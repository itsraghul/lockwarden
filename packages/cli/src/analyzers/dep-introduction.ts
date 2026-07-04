import type { Analyzer, Signal } from './types.ts';

/**
 * LW006 — tree-scoped, DELTA ONLY: a new transitive dependency entering the
 * tree via a patch-level bump of an existing package. This is the exact
 * axios → plain-crypto-js (Mar 2026) vector: nobody re-reviews a patch bump,
 * and that is where the payload package rides in.
 *
 * Approximation (documented): any `added` key whose package name is not
 * itself a changed-version package is attributed to the patch bump(s) in the
 * same lockfile diff. Precise parent attribution needs the resolved edge
 * list, which the unified lockfile model will provide when promoted.
 */

/** name@version key → { name, version } (scoped names keep their @). */
function splitKey(key: string): { name: string; version: string } {
  const at = key.lastIndexOf('@');
  if (at <= 0) return { name: key, version: '' };
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Tiny local patch-bump check — corpus stays builtin-only, so no semver dep.
 * Prerelease or otherwise unusual versions are conservatively NOT a patch bump.
 */
export function isPatchBump(from: string, to: string): boolean {
  const f = SEMVER_RE.exec(from);
  const t = SEMVER_RE.exec(to);
  if (f === null || t === null) return false;
  return f[1] === t[1] && f[2] === t[2] && Number(t[3]) > Number(f[3]);
}

export const depIntroductionAnalyzer: Analyzer = {
  id: 'dep-introduction',
  scope: 'tree',
  needsPrevious: false,
  needsProject: false,
  async analyze(ctx) {
    const signals: Signal[] = [];
    const diff = ctx.graphDiff;
    if (diff === undefined) return signals;

    const patchBumped: string[] = [];
    for (const [name, { from, to }] of diff.changed) {
      if (isPatchBump(from, to)) patchBumped.push(`${name} ${from} → ${to}`);
    }
    if (patchBumped.length === 0) return signals;

    const changedNames = new Set(diff.changed.keys());
    for (const key of diff.added) {
      const { name, version } = splitKey(key);
      if (changedNames.has(name)) continue; // its own version change, not a new arrival
      signals.push({
        analyzer: 'dep-introduction',
        code: 'LW006D-PATCH-DEP-INTRODUCED',
        kind: 'delta',
        package: { name, version },
        evidence: {
          detail: `new transitive dependency ${key} entered the tree alongside patch bump(s): ${patchBumped.join(', ')}`,
        },
        metrics: { patchBumpedPackages: patchBumped.length },
      });
    }
    return signals;
  },
};
