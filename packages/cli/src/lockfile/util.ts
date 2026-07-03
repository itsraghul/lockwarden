/** Tiny helpers shared by the lockfile parsers. */
import semver from 'semver';
import type { PkgKey } from './types.js';
import { makeKey } from './types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a dependencies-shaped section (name -> range) off a parsed package.json. */
export function manifestSection(
  manifest: Record<string, unknown> | undefined,
  field: string,
): Record<string, string> | undefined {
  if (!manifest || !isRecord(manifest[field])) return undefined;
  return manifest[field] as Record<string, string>;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Last-resort descriptor resolution: pick the highest known version of
 * `name` that satisfies `range`. Used when a lockfile entry's descriptor
 * map has no exact hit (e.g. hand-edited lockfiles).
 */
export function semverFallback(
  versionsByName: Map<string, string[]>,
  name: string,
  range: string,
): PkgKey | undefined {
  const versions = versionsByName.get(name);
  if (!versions || versions.length === 0) return undefined;
  if (!semver.validRange(range)) return undefined;
  const best = semver.maxSatisfying(versions, range);
  return best ? makeKey(name, best) : undefined;
}
