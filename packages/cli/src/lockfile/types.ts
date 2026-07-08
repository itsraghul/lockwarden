/**
 * Unified resolution model shared by every lockfile parser (npm, yarn v1,
 * yarn berry, pnpm). The lockfile is the source of truth — nothing here is
 * ever derived from package.json alone; the root manifest only classifies
 * root edges (prod/dev/optional) where the lockfile itself does not.
 */

/** "name@version" — the canonical identity of one resolved package. */
export type PkgKey = `${string}@${string}`;

/** Sentinel for the project root in edges and paths. */
export const ROOT = '<root>' as const;
export type RootMarker = typeof ROOT;

export type LockfileType = 'npm' | 'yarn-classic' | 'yarn-berry' | 'pnpm' | 'bun';

export type EdgeType = 'prod' | 'dev' | 'optional' | 'peer';

export interface ResolvedPackage {
  key: PkgKey;
  name: string;
  version: string;
  /** Registry tarball URL when the lockfile records one. */
  resolved?: string;
  integrity?: string;
  /** Reachable ONLY via dev edges from the root (computed in finalizeGraph). */
  dev: boolean;
  /** Reachable ONLY via optional edges from the root (computed in finalizeGraph). */
  optional: boolean;
  /** Only npm lockfiles v2/v3 and pnpm (requiresBuild) record this. */
  hasInstallScript?: boolean;
  /**
   * Format-native locations of this package: node_modules paths (npm),
   * descriptors (yarn), raw locator keys incl. peer suffixes (pnpm).
   */
  locators: string[];
}

export interface DependencyEdge {
  from: PkgKey | RootMarker;
  to: PkgKey;
  type: EdgeType;
  /** The requested range as written in the lockfile / manifest. */
  range: string;
}

export interface ResolutionGraph {
  lockfileType: LockfileType;
  lockfileVersion: string;
  lockfilePath: string;
  packages: Map<PkgKey, ResolvedPackage>;
  edges: DependencyEdge[];
  /** Reverse index: for each package, the edges that point at it. */
  inbound: Map<PkgKey, DependencyEdge[]>;
  warnings: string[];
}

/** One root→target chain; each element's `range` is the range on the edge INTO it. */
export type DependencyPath = Array<{ key: PkgKey | RootMarker; range?: string }>;

export interface ParseContext {
  lockfilePath: string;
  /** Parsed package.json of the project root, when available. */
  rootManifest?: Record<string, unknown>;
}

export function makeKey(name: string, version: string): PkgKey {
  return `${name}@${version}`;
}

/** Split "name@spec" on the last @ that is not position 0 (scoped-safe). */
export function splitNameSpec(input: string): { name: string; spec: string | null } {
  const at = input.lastIndexOf('@');
  if (at <= 0) return { name: input, spec: null };
  return { name: input.slice(0, at), spec: input.slice(at + 1) };
}
