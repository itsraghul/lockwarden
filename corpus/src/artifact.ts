import type { Buffer } from 'node:buffer';
import type { FileEntry, PackageArtifact } from '../../packages/cli/src/analyzers/types.ts';
import { readTarGz } from '../../packages/cli/src/lib/tar.ts';

/**
 * Corpus-side tarball → PackageArtifact loader.
 *
 * MIRRORS packages/cli/src/lib/artifact.ts (tarballToArtifact). The corpus
 * runs under `node --experimental-strip-types`, which cannot follow the
 * CLI's `.js`-suffixed ESM specifiers, so the ~40 lines of assembly logic
 * are duplicated here with the same semantics. tar.ts itself only imports
 * node builtins, so it is shared directly. Keep the stripping rules in
 * sync with the CLI copy.
 */

export interface RawEntry {
  path: string;
  size: number;
  data: Buffer;
}

/** Strip the single top-level dir (usually `package/`) — any single top dir. */
export function stripTopDir(entries: RawEntry[]): RawEntry[] {
  if (entries.length === 0) return entries;
  let top: string | undefined;
  for (const entry of entries) {
    const slash = entry.path.indexOf('/');
    if (slash <= 0) return entries;
    const first = entry.path.slice(0, slash);
    if (top === undefined) top = first;
    else if (top !== first) return entries;
  }
  return entries.map((e) => ({ ...e, path: e.path.slice(e.path.indexOf('/') + 1) }));
}

function parseManifest(buf: Buffer | undefined): Record<string, unknown> {
  if (buf === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(buf.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // tolerated: empty manifest + fallback identity
  }
  return {};
}

/** Read a tarball's entries with the top-level dir already stripped. */
export async function readPackageEntries(data: Buffer): Promise<RawEntry[]> {
  return stripTopDir(await readTarGz(data));
}

export async function tarballToArtifact(
  data: Buffer,
  fallback?: { name?: string; version?: string },
): Promise<PackageArtifact> {
  const entries = await readPackageEntries(data);
  const files = new Map<string, FileEntry>();
  let totalSize = 0;
  for (const entry of entries) {
    if (entry.path === '') continue;
    files.set(entry.path, {
      path: entry.path,
      size: entry.size,
      read: () => Promise.resolve(entry.data),
    });
    totalSize += entry.size;
  }

  const manifestEntry = entries.find((e) => e.path === 'package.json');
  const manifest = parseManifest(manifestEntry?.data);
  const name = typeof manifest.name === 'string' ? manifest.name : (fallback?.name ?? 'unknown');
  const version =
    typeof manifest.version === 'string' ? manifest.version : (fallback?.version ?? '0.0.0');

  return { name, version, manifest, files, totalSize };
}
