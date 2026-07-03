import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileEntry, PackageArtifact } from '../analyzers/types.js';
import { readTarGz } from './tar.js';

/**
 * Builders for the PackageArtifact model analyzers consume — from registry
 * tarballs (audit --diff/--deep, check), or from directories on disk
 * (scan fallback, corpus dir mode).
 *
 * NOTE (corpus): corpus/src/artifact.ts mirrors the tarball-assembly logic
 * here because `node --experimental-strip-types` cannot follow this file's
 * `.js`-suffixed ESM imports. Keep the stripping rules in sync.
 */

interface RawEntry {
  path: string;
  size: number;
  data: Buffer;
}

/**
 * Strip the single top-level directory npm tarballs carry (usually
 * `package/`, but the registry accepts any single top dir). If entries do
 * not all share one top-level directory, paths are kept as-is.
 */
function stripTopDir(entries: RawEntry[]): RawEntry[] {
  if (entries.length === 0) return entries;
  let top: string | undefined;
  for (const entry of entries) {
    const slash = entry.path.indexOf('/');
    if (slash <= 0) return entries; // a root-level file: nothing to strip
    const first = entry.path.slice(0, slash);
    if (top === undefined) top = first;
    else if (top !== first) return entries; // multiple top dirs: keep as-is
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
    // tolerated: fall back to an empty manifest + caller-provided identity
  }
  return {};
}

function assembleArtifact(
  entries: RawEntry[],
  fallback?: { name?: string; version?: string },
): PackageArtifact {
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

/** Decode a registry tarball into the analyzer-facing artifact model. */
export async function tarballToArtifact(
  data: Buffer,
  fallback?: { name?: string; version?: string },
): Promise<PackageArtifact> {
  const entries = stripTopDir(await readTarGz(data));
  return assembleArtifact(entries, fallback);
}

const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * Build an artifact from a directory on disk (recursive; node_modules and
 * .git are skipped; symlinks are not followed). File contents are read
 * lazily — FileEntry.read() hits the disk on demand.
 */
export async function dirToArtifact(dir: string): Promise<PackageArtifact> {
  const root = path.resolve(dir);
  const files = new Map<string, FileEntry>();
  let totalSize = 0;

  async function walk(current: string, relPrefix: string): Promise<void> {
    const dirents = await readdir(current, { withFileTypes: true });
    for (const dirent of dirents) {
      const abs = path.join(current, dirent.name);
      const rel = relPrefix === '' ? dirent.name : `${relPrefix}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) continue;
        await walk(abs, rel);
      } else if (dirent.isFile()) {
        const info = await stat(abs);
        files.set(rel, {
          path: rel,
          size: info.size,
          read: () => readFile(abs),
        });
        totalSize += info.size;
      }
      // symlinks and special files: skipped, never followed
    }
  }

  await walk(root, '');

  let manifest: Record<string, unknown> = {};
  const manifestEntry = files.get('package.json');
  if (manifestEntry !== undefined) {
    manifest = parseManifest(await manifestEntry.read());
  }
  const name = typeof manifest.name === 'string' ? manifest.name : path.basename(root);
  const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0';

  return { name, version, manifest, files, totalSize };
}
