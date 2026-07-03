/**
 * package-lock.json parser. lockfileVersion 2/3 via the `packages` map
 * (authoritative); lockfileVersion 1 falls back to a best-effort walk of
 * the nested `dependencies` tree with a warning.
 *
 * Edge resolution for v2/v3 follows node_modules nesting exactly like the
 * Node resolver: for a package at path P depending on name N, resolve to
 * the deepest `<prefix>/node_modules/N` walking up from P.
 */
import { ExecError } from '../exit.js';
import type { GraphDraft } from './finalize.js';
import { finalizeGraph } from './finalize.js';
import type {
  DependencyEdge,
  EdgeType,
  ParseContext,
  PkgKey,
  ResolutionGraph,
  ResolvedPackage,
  RootMarker,
} from './types.js';
import { ROOT, makeKey } from './types.js';
import { errorMessage, isRecord, manifestSection } from './util.js';

interface NpmLockEntry {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  hasInstallScript?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface V1Entry {
  version?: string;
  resolved?: string;
  integrity?: string;
  dev?: boolean;
  optional?: boolean;
  requires?: Record<string, string>;
  dependencies?: Record<string, V1Entry>;
}

export function parseNpm(content: string, ctx: ParseContext): ResolutionGraph {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch (err) {
    throw new ExecError(`${ctx.lockfilePath}: invalid JSON — ${errorMessage(err)}`);
  }
  if (!isRecord(doc)) {
    throw new ExecError(`${ctx.lockfilePath}: expected a JSON object`);
  }

  const lockfileVersion = String(doc.lockfileVersion ?? '1');
  const warnings: string[] = [];

  if (isRecord(doc.packages)) {
    return parsePackagesMap(doc.packages, ctx, lockfileVersion, warnings);
  }

  warnings.push(
    `lockfileVersion ${lockfileVersion} has no "packages" map; best-effort parse of the nested tree`,
  );
  const deps = isRecord(doc.dependencies) ? (doc.dependencies as Record<string, V1Entry>) : {};
  return parseV1(deps, ctx, lockfileVersion, warnings);
}

/* ------------------------------- v2 / v3 ------------------------------- */

function parsePackagesMap(
  rawPackages: Record<string, unknown>,
  ctx: ParseContext,
  lockfileVersion: string,
  warnings: string[],
): ResolutionGraph {
  const byPath = new Map<string, { key: PkgKey; entry: NpmLockEntry }>();
  const packages = new Map<PkgKey, ResolvedPackage>();
  const edges: DependencyEdge[] = [];

  for (const [path, raw] of Object.entries(rawPackages)) {
    if (path === '' || !isRecord(raw)) continue;
    const entry = raw as NpmLockEntry;
    if (entry.link === true) continue; // workspace symlink stub
    if (!path.includes('node_modules/')) {
      warnings.push(`skipping non-node_modules entry "${path}" (workspace packages not modeled)`);
      continue;
    }
    const name = entry.name ?? nameFromPath(path);
    const version = entry.version;
    if (!name || !version) {
      warnings.push(`skipping "${path}": missing name or version`);
      continue;
    }
    const key = makeKey(name, version);
    byPath.set(path, { key, entry });
    const existing = packages.get(key);
    if (existing) {
      existing.locators.push(path);
      if (entry.hasInstallScript) existing.hasInstallScript = true;
      existing.resolved ??= entry.resolved;
      existing.integrity ??= entry.integrity;
    } else {
      packages.set(key, {
        key,
        name,
        version,
        resolved: entry.resolved,
        integrity: entry.integrity,
        dev: false,
        optional: false,
        hasInstallScript: entry.hasInstallScript === true ? true : undefined,
        locators: [path],
      });
    }
  }

  const addEdges = (
    fromPath: string,
    from: PkgKey | RootMarker,
    deps: Record<string, string> | undefined,
    type: EdgeType,
    silentWhenMissing: boolean,
  ): void => {
    if (!deps) return;
    for (const [depName, range] of Object.entries(deps)) {
      const targetPath = resolveDepPath(fromPath, depName, byPath);
      if (!targetPath) {
        if (!silentWhenMissing) {
          warnings.push(`cannot resolve ${depName}@${range} from "${fromPath || '<root>'}"`);
        }
        continue;
      }
      const target = byPath.get(targetPath);
      if (target) edges.push({ from, to: target.key, type, range: String(range) });
    }
  };

  const rootEntry = isRecord(rawPackages['']) ? (rawPackages[''] as NpmLockEntry) : {};
  const manifest = ctx.rootManifest;
  const rootDeps = rootEntry.dependencies ?? manifestSection(manifest, 'dependencies');
  const rootDev = rootEntry.devDependencies ?? manifestSection(manifest, 'devDependencies');
  const rootOptional =
    rootEntry.optionalDependencies ?? manifestSection(manifest, 'optionalDependencies');
  const rootPeer = rootEntry.peerDependencies ?? manifestSection(manifest, 'peerDependencies');

  addEdges('', ROOT, rootDeps, 'prod', false);
  addEdges('', ROOT, rootDev, 'dev', false);
  addEdges('', ROOT, rootOptional, 'optional', true);
  addEdges('', ROOT, rootPeer, 'peer', true);

  for (const [path, { key, entry }] of byPath) {
    addEdges(path, key, entry.dependencies, 'prod', false);
    addEdges(path, key, entry.optionalDependencies, 'optional', true);
    addEdges(path, key, entry.peerDependencies, 'peer', true);
  }

  const draft: GraphDraft = {
    lockfileType: 'npm',
    lockfileVersion,
    lockfilePath: ctx.lockfilePath,
    packages,
    edges,
    warnings,
  };
  return finalizeGraph(draft);
}

/** "node_modules/a/node_modules/@scope/b" -> "@scope/b" */
function nameFromPath(path: string): string {
  const marker = 'node_modules/';
  const idx = path.lastIndexOf(marker);
  return idx === -1 ? path : path.slice(idx + marker.length);
}

/** Walk up the node_modules nesting from `fromPath` to find the deepest install of `name`. */
function resolveDepPath(
  fromPath: string,
  name: string,
  byPath: Map<string, unknown>,
): string | undefined {
  let prefix = fromPath;
  for (;;) {
    const candidate = prefix === '' ? `node_modules/${name}` : `${prefix}/node_modules/${name}`;
    if (byPath.has(candidate)) return candidate;
    if (prefix === '') return undefined;
    const idx = prefix.lastIndexOf('/node_modules/');
    prefix = idx === -1 ? '' : prefix.slice(0, idx);
  }
}

/* --------------------------------- v1 ---------------------------------- */

function parseV1(
  topDeps: Record<string, V1Entry>,
  ctx: ParseContext,
  lockfileVersion: string,
  warnings: string[],
): ResolutionGraph {
  const packages = new Map<PkgKey, ResolvedPackage>();
  const edges: DependencyEdge[] = [];

  const scopeOf = (deps: Record<string, V1Entry>): Map<string, PkgKey> => {
    const scope = new Map<string, PkgKey>();
    for (const [name, entry] of Object.entries(deps)) {
      if (entry.version) scope.set(name, makeKey(name, entry.version));
    }
    return scope;
  };

  const lookup = (chain: Array<Map<string, PkgKey>>, name: string): PkgKey | undefined => {
    for (const scope of chain) {
      const hit = scope.get(name);
      if (hit) return hit;
    }
    return undefined;
  };

  const visit = (deps: Record<string, V1Entry>, parentChain: Array<Map<string, PkgKey>>): void => {
    const chain = [scopeOf(deps), ...parentChain];
    for (const [name, entry] of Object.entries(deps)) {
      if (!entry.version) {
        warnings.push(`skipping "${name}": missing version`);
        continue;
      }
      const key = makeKey(name, entry.version);
      if (!packages.has(key)) {
        packages.set(key, {
          key,
          name,
          version: entry.version,
          resolved: entry.resolved,
          integrity: entry.integrity,
          dev: false,
          optional: false,
          locators: [key],
        });
      }
      let localChain = chain;
      if (entry.dependencies) {
        localChain = [scopeOf(entry.dependencies), ...chain];
        visit(entry.dependencies, chain);
      }
      for (const [reqName, range] of Object.entries(entry.requires ?? {})) {
        const target = lookup(localChain, reqName);
        if (target) edges.push({ from: key, to: target, type: 'prod', range: String(range) });
        else warnings.push(`cannot resolve ${reqName}@${range} required by ${key}`);
      }
    }
  };

  visit(topDeps, []);

  const topScope = scopeOf(topDeps);
  const manifest = ctx.rootManifest;
  if (manifest) {
    const sections: Array<[Record<string, string> | undefined, EdgeType]> = [
      [manifestSection(manifest, 'dependencies'), 'prod'],
      [manifestSection(manifest, 'devDependencies'), 'dev'],
      [manifestSection(manifest, 'optionalDependencies'), 'optional'],
    ];
    for (const [section, type] of sections) {
      for (const [name, range] of Object.entries(section ?? {})) {
        const target = topScope.get(name);
        if (target) edges.push({ from: ROOT, to: target, type, range: String(range) });
        else if (type !== 'optional') {
          warnings.push(`root dependency ${name}@${range} not found in lockfile`);
        }
      }
    }
  } else {
    for (const [name, entry] of Object.entries(topDeps)) {
      if (!entry.version) continue;
      edges.push({
        from: ROOT,
        to: makeKey(name, entry.version),
        type: entry.dev ? 'dev' : entry.optional ? 'optional' : 'prod',
        range: entry.version,
      });
    }
  }

  return finalizeGraph({
    lockfileType: 'npm',
    lockfileVersion,
    lockfilePath: ctx.lockfilePath,
    packages,
    edges,
    warnings,
  });
}
