import { isPatchBump } from '../analyzers/index.js';
import type { LockfileDiffView } from '../analyzers/types.js';
import { type PkgKey, type ResolutionGraph, makeKey } from '../lockfile/types.js';

/**
 * Structural diff between a base lockfile graph (from a git ref) and the
 * current one. This is what scopes --diff network fetches: previous tarballs
 * are fetched ONLY for `changed` packages.
 *
 * "Changed" means the name resolves to exactly one version on each side and
 * they differ — the unambiguous version-bump case. Names with multiple
 * resolved versions on either side contribute added/removed keys instead
 * (a second copy appearing IS an arrival, not a bump).
 */

export interface ChangedPackage {
  from: string;
  to: string;
  /** resolved tarball URL recorded in the BASE lockfile, when present */
  baseResolved?: string;
  /** integrity recorded in the BASE lockfile, when present */
  baseIntegrity?: string;
}

export interface LockfileDiff {
  /** name → version change; previous tarball fetches are scoped to this map */
  changed: Map<string, ChangedPackage>;
  /** name@version keys present now but not in base */
  added: Set<PkgKey>;
  /** name@version keys present in base but not now */
  removed: Set<PkgKey>;
  /**
   * Convenience subset of `added`: new arrivals while at least one existing
   * package was patch-bumped — the axios → plain-crypto-js shape. The
   * dep-introduction analyzer recomputes this from the diff view; this set
   * exists for reporting/debugging.
   */
  addedTransitiveUnderPatch: Set<PkgKey>;
}

function versionsByName(graph: ResolutionGraph): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>();
  for (const pkg of graph.packages.values()) {
    let versions = byName.get(pkg.name);
    if (versions === undefined) {
      versions = new Set();
      byName.set(pkg.name, versions);
    }
    versions.add(pkg.version);
  }
  return byName;
}

function single<T>(set: ReadonlySet<T>): T | undefined {
  if (set.size !== 1) return undefined;
  for (const value of set) return value;
  return undefined;
}

export function diffGraphs(base: ResolutionGraph, current: ResolutionGraph): LockfileDiff {
  const baseByName = versionsByName(base);
  const currentByName = versionsByName(current);

  const changed = new Map<string, ChangedPackage>();
  const added = new Set<PkgKey>();
  const removed = new Set<PkgKey>();

  for (const [name, currentVersions] of currentByName) {
    const baseVersions = baseByName.get(name);
    if (baseVersions === undefined) {
      for (const version of currentVersions) added.add(makeKey(name, version));
      continue;
    }
    const from = single(baseVersions);
    const to = single(currentVersions);
    if (from !== undefined && to !== undefined) {
      if (from !== to) {
        const basePkg = base.packages.get(makeKey(name, from));
        changed.set(name, {
          from,
          to,
          baseResolved: basePkg?.resolved,
          baseIntegrity: basePkg?.integrity,
        });
      }
      continue;
    }
    // multiple versions on at least one side: per-key set difference
    for (const version of currentVersions) {
      if (!baseVersions.has(version)) added.add(makeKey(name, version));
    }
    for (const version of baseVersions) {
      if (!currentVersions.has(version)) removed.add(makeKey(name, version));
    }
  }

  for (const [name, baseVersions] of baseByName) {
    if (currentByName.has(name)) continue;
    for (const version of baseVersions) removed.add(makeKey(name, version));
  }

  const anyPatchBump = [...changed.values()].some((c) => isPatchBump(c.from, c.to));
  const addedTransitiveUnderPatch = new Set<PkgKey>();
  if (anyPatchBump) {
    for (const key of added) {
      const at = key.lastIndexOf('@');
      const name = at > 0 ? key.slice(0, at) : key;
      if (!changed.has(name)) addedTransitiveUnderPatch.add(key);
    }
  }

  return { changed, added, removed, addedTransitiveUnderPatch };
}

/** The analyzer-facing view (analyzers/types.ts LockfileDiffView). */
export function toDiffView(diff: LockfileDiff): LockfileDiffView {
  const changed = new Map<string, { from: string; to: string }>();
  for (const [name, c] of diff.changed) changed.set(name, { from: c.from, to: c.to });
  return { changed, added: diff.added, removed: diff.removed };
}
