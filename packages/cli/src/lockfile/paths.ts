/**
 * Graph queries used by `check` and friends:
 *
 * enumeratePaths — every simple path by which a package enters the tree
 *                  (reverse DFS over the inbound index, cycle-safe, capped).
 * matchPackages  — resolve a user query ("name", "name@1.2.3",
 *                  "@scope/pkg@^1") to concrete PkgKeys.
 */
import semver from 'semver';
import type { DependencyPath, PkgKey, ResolutionGraph } from './types.js';
import { ROOT, splitNameSpec } from './types.js';

export interface EnumeratePathsResult {
  paths: DependencyPath[];
  truncated: boolean;
}

export function enumeratePaths(
  graph: ResolutionGraph,
  targetKey: PkgKey,
  options: { maxPaths?: number } = {},
): EnumeratePathsResult {
  const maxPaths = options.maxPaths ?? 500;
  const paths: DependencyPath[] = [];
  let truncated = false;

  if (!graph.packages.has(targetKey) || maxPaths <= 0) {
    return { paths, truncated: maxPaths <= 0 && graph.packages.has(targetKey) };
  }

  const onPath = new Set<PkgKey>();

  const visit = (key: PkgKey, suffix: DependencyPath): void => {
    if (truncated) return;
    onPath.add(key);
    for (const edge of graph.inbound.get(key) ?? []) {
      if (truncated) break;
      const step = { key, range: edge.range };
      if (edge.from === ROOT) {
        if (paths.length >= maxPaths) {
          truncated = true;
          break;
        }
        paths.push([{ key: ROOT }, step, ...suffix]);
        continue;
      }
      if (onPath.has(edge.from)) continue; // cycle — skip this edge
      visit(edge.from, [step, ...suffix]);
    }
    onPath.delete(key);
  };

  visit(targetKey, []);
  return { paths, truncated };
}

/**
 * Query forms: `name` (all versions), `name@1.2.3` (exact),
 * `name@^1` / `name@>=2 <3` (semver range). Scoped names are split on the
 * last @ that is not position 0, so `@scope/pkg@^1` parses correctly.
 */
export function matchPackages(graph: ResolutionGraph, query: string): PkgKey[] {
  const { name, spec } = splitNameSpec(query.trim());
  const out: PkgKey[] = [];
  for (const pkg of graph.packages.values()) {
    if (pkg.name !== name) continue;
    if (spec === null || spec === pkg.version) {
      out.push(pkg.key);
      continue;
    }
    if (
      semver.validRange(spec) !== null &&
      semver.valid(pkg.version) !== null &&
      semver.satisfies(pkg.version, spec)
    ) {
      out.push(pkg.key);
    }
  }
  return out.sort();
}
