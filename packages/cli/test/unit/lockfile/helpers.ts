import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeGraph } from '../../../src/lockfile/finalize.js';
import type {
  DependencyEdge,
  EdgeType,
  PkgKey,
  ResolutionGraph,
  ResolvedPackage,
  RootMarker,
} from '../../../src/lockfile/types.js';
import { ROOT, splitNameSpec } from '../../../src/lockfile/types.js';

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURES = join(here, '..', '..', 'fixtures', 'projects');

export function fixtureDir(name: string): string {
  return join(FIXTURES, name);
}

type EdgeSpec = [from: PkgKey | RootMarker, to: PkgKey, type?: EdgeType, range?: string];

/** Build a finalized graph from shorthand edges; packages are inferred from keys. */
export function buildGraph(edgeSpecs: EdgeSpec[]): ResolutionGraph {
  const packages = new Map<PkgKey, ResolvedPackage>();
  const edges: DependencyEdge[] = [];
  const ensure = (key: PkgKey | RootMarker): void => {
    if (key === ROOT || packages.has(key)) return;
    const { name, spec } = splitNameSpec(key);
    packages.set(key, {
      key,
      name,
      version: spec ?? '0.0.0',
      dev: false,
      optional: false,
      locators: [key],
    });
  };
  for (const [from, to, type = 'prod', range = '*'] of edgeSpecs) {
    ensure(from);
    ensure(to);
    edges.push({ from, to, type, range });
  }
  return finalizeGraph({
    lockfileType: 'npm',
    lockfileVersion: '3',
    lockfilePath: '/virtual/package-lock.json',
    packages,
    edges,
    warnings: [],
  });
}

export function edgeKeys(graph: ResolutionGraph): string[] {
  return graph.edges.map((e) => `${e.from} -> ${e.to} (${e.type})`).sort();
}
