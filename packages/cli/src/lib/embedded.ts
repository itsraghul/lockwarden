import type { FileEntry, PackageArtifact } from '../analyzers/types.js';

/**
 * Embedded package-root discovery for `scan`: given the flat file map of an
 * extracted artifact (tarball, zip, docker image filesystem, directory),
 * find every vendored/pre-baked package root and build a PackageArtifact
 * per root — what's ACTUALLY on disk, not what a manifest claims.
 *
 * A root is any `package.json` that parses with a string name+version:
 *   - node_modules roots (`**\/node_modules/<name>/package.json`, including
 *     scoped `@scope/<name>`) — preferred, ordered depth-first
 *   - the artifact's own root package.json (or single-top-dir equivalent)
 *   - any other embedded app/workspace package.json
 *
 * Each root's artifact contains the files under it EXCLUDING nested
 * node_modules subtrees — those belong to the nested packages, which are
 * discovered as their own roots (mirrors dirToArtifact's walk policy).
 */

/** Safety cap — a hostile artifact must not make scan allocate unboundedly. */
export const MAX_EMBEDDED_ROOTS = 2000;

export interface EmbeddedPackage {
  /** artifact-relative posix path of the package root ('' = artifact root) */
  root: string;
  artifact: PackageArtifact;
}

export interface EmbeddedScanResult {
  packages: EmbeddedPackage[];
  warnings: string[];
}

interface Candidate {
  root: string;
  depth: number;
  nodeModules: boolean;
  manifest: Record<string, unknown>;
  name: string;
  version: string;
}

/** node_modules/<name> or node_modules/@scope/<name>? */
function isNodeModulesRoot(root: string): boolean {
  const segments = root.split('/');
  const parent = segments[segments.length - 2];
  if (parent === 'node_modules') return true;
  const grandparent = segments[segments.length - 3];
  return grandparent === 'node_modules' && parent !== undefined && parent.startsWith('@');
}

function parseManifest(buf: Buffer): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(buf.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // unparseable manifest: not a package root
  }
  return undefined;
}

async function candidateAt(path: string, entry: FileEntry): Promise<Candidate | undefined> {
  const manifest = parseManifest(await entry.read());
  if (manifest === undefined) return undefined;
  const { name, version } = manifest;
  if (typeof name !== 'string' || name === '' || typeof version !== 'string' || version === '') {
    return undefined;
  }
  const root = path === 'package.json' ? '' : path.slice(0, -'/package.json'.length);
  return {
    root,
    depth: root === '' ? 0 : root.split('/').length,
    nodeModules: root !== '' && isNodeModulesRoot(root),
    manifest,
    name,
    version,
  };
}

function buildArtifact(files: Map<string, FileEntry>, candidate: Candidate): PackageArtifact {
  const prefix = candidate.root === '' ? '' : `${candidate.root}/`;
  const scoped = new Map<string, FileEntry>();
  let totalSize = 0;
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length);
    if (rel === '') continue;
    // nested node_modules belong to their own discovered roots
    if (rel.split('/').includes('node_modules')) continue;
    scoped.set(rel, { path: rel, size: entry.size, read: entry.read });
    totalSize += entry.size;
  }
  return {
    name: candidate.name,
    version: candidate.version,
    manifest: candidate.manifest,
    files: scoped,
    totalSize,
  };
}

/**
 * Discover every embedded package root in a flat artifact file map and build
 * a PackageArtifact per root (files scoped under that root, paths relative
 * to it). Capped at MAX_EMBEDDED_ROOTS, preferring node_modules roots
 * (depth-first) so vendored dependency coverage survives the cap.
 */
export async function findEmbeddedRoots(
  files: Map<string, FileEntry>,
): Promise<EmbeddedScanResult> {
  const warnings: string[] = [];
  const candidates: Candidate[] = [];

  for (const [path, entry] of files) {
    if (path !== 'package.json' && !path.endsWith('/package.json')) continue;
    const candidate = await candidateAt(path, entry);
    if (candidate !== undefined) candidates.push(candidate);
  }

  // Preference order: node_modules roots depth-first (deepest first), then
  // the remaining roots shallow-first; lexicographic within a depth tier.
  candidates.sort((a, b) => {
    if (a.nodeModules !== b.nodeModules) return a.nodeModules ? -1 : 1;
    if (a.nodeModules) return b.depth - a.depth || a.root.localeCompare(b.root);
    return a.depth - b.depth || a.root.localeCompare(b.root);
  });

  let kept = candidates;
  if (candidates.length > MAX_EMBEDDED_ROOTS) {
    kept = candidates.slice(0, MAX_EMBEDDED_ROOTS);
    warnings.push(
      `embedded package roots capped at ${MAX_EMBEDDED_ROOTS} (found ${candidates.length}) — deepest node_modules roots kept first`,
    );
  }

  const packages = kept
    .map((candidate) => ({ root: candidate.root, artifact: buildArtifact(files, candidate) }))
    .sort((a, b) => a.root.localeCompare(b.root));

  return { packages, warnings };
}
