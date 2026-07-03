/**
 * pnpm-lock.yaml parser for lockfileVersion 6.0 and 9.0.
 *
 * v6: `packages:` keyed `/name@version(peerhash)` with inline
 *     dependencies. v9: `packages:` keyed `name@version` carries metadata,
 *     `snapshots:` keyed `name@version(peer@v)` carries dependencies.
 * `importers:` ('.' et al) provide root prod/dev/optional edges.
 * Peer-suffix parentheses are stripped when forming PkgKeys; the raw
 * locator keys are kept in `locators`.
 */
import { parse as parseYaml } from 'yaml';
import { ExecError } from '../exit.js';
import { finalizeGraph } from './finalize.js';
import type {
  DependencyEdge,
  EdgeType,
  ParseContext,
  PkgKey,
  ResolutionGraph,
  ResolvedPackage,
} from './types.js';
import { ROOT, makeKey } from './types.js';
import { errorMessage, isRecord } from './util.js';

export function parsePnpm(content: string, ctx: ParseContext): ResolutionGraph {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch (err) {
    throw new ExecError(`${ctx.lockfilePath}: invalid YAML — ${errorMessage(err)}`);
  }
  if (!isRecord(doc)) {
    throw new ExecError(`${ctx.lockfilePath}: expected a YAML mapping`);
  }

  const lockfileVersion = String(doc.lockfileVersion ?? '');
  const major = Number.parseInt(lockfileVersion, 10);
  if (Number.isNaN(major)) {
    throw new ExecError(`${ctx.lockfilePath}: missing/invalid lockfileVersion`);
  }
  const warnings: string[] = [];
  if (major !== 6 && major !== 9) {
    warnings.push(
      `pnpm lockfileVersion ${lockfileVersion} unsupported (expected 6.0/9.0); best-effort parse`,
    );
  }
  const v9 = major >= 9 || isRecord(doc.snapshots);

  const packages = new Map<PkgKey, ResolvedPackage>();
  const edges: DependencyEdge[] = [];

  const registerLocator = (rawKey: string): PkgKey | undefined => {
    const loc = parseLocator(rawKey);
    if (!loc) {
      warnings.push(`cannot parse package locator "${rawKey}"`);
      return undefined;
    }
    const key = makeKey(loc.name, loc.version);
    const existing = packages.get(key);
    if (existing) {
      if (!existing.locators.includes(rawKey)) existing.locators.push(rawKey);
      return key;
    }
    packages.set(key, {
      key,
      name: loc.name,
      version: loc.version,
      dev: false,
      optional: false,
      locators: [rawKey],
    });
    return key;
  };

  // Pass 1: register every package so edge targets resolve regardless of
  // the order entries appear in the lockfile.
  const rawPackages = isRecord(doc.packages) ? doc.packages : {};
  const registered: Array<{ key: PkgKey; value: Record<string, unknown> }> = [];
  for (const [rawKey, value] of Object.entries(rawPackages)) {
    const key = registerLocator(rawKey);
    if (!key || !isRecord(value)) continue;
    const pkg = packages.get(key);
    if (!pkg) continue;
    const resolution = isRecord(value.resolution) ? value.resolution : {};
    if (resolution.integrity !== undefined) pkg.integrity ??= String(resolution.integrity);
    if (resolution.tarball !== undefined) pkg.resolved ??= String(resolution.tarball);
    if (value.requiresBuild === true) pkg.hasInstallScript = true;
    registered.push({ key, value });
  }

  // Pass 2 (v6 only): dependencies live inline on the package entries.
  if (!v9) {
    for (const { key, value } of registered) {
      addDepEdges(key, value, edges, packages, warnings);
    }
  }

  if (v9) {
    const snapshots = isRecord(doc.snapshots) ? doc.snapshots : {};
    for (const [rawKey, value] of Object.entries(snapshots)) {
      const loc = parseLocator(rawKey);
      if (!loc) {
        warnings.push(`cannot parse snapshot locator "${rawKey}"`);
        continue;
      }
      const key = makeKey(loc.name, loc.version);
      const pkg = packages.get(key);
      if (!pkg) {
        warnings.push(`snapshot "${rawKey}" has no matching entry in packages:`);
        registerLocator(rawKey);
      } else if (!pkg.locators.includes(rawKey)) {
        pkg.locators.push(rawKey);
      }
      if (!isRecord(value)) continue;
      if (value.requiresBuild === true) {
        const p = packages.get(key);
        if (p) p.hasInstallScript = true;
      }
      addDepEdges(key, value, edges, packages, warnings);
    }
  }

  // Root edges from importers ('.' et al), or the v6 single-project
  // top-level dependencies/devDependencies/optionalDependencies form.
  const importers = isRecord(doc.importers)
    ? doc.importers
    : {
        '.': {
          dependencies: doc.dependencies,
          devDependencies: doc.devDependencies,
          optionalDependencies: doc.optionalDependencies,
        },
      };
  const sections: Array<[string, EdgeType]> = [
    ['dependencies', 'prod'],
    ['devDependencies', 'dev'],
    ['optionalDependencies', 'optional'],
  ];
  for (const [importerPath, importer] of Object.entries(importers)) {
    if (!isRecord(importer)) continue;
    for (const [sectionName, type] of sections) {
      const section = importer[sectionName];
      if (!isRecord(section)) continue;
      for (const [depName, spec] of Object.entries(section)) {
        let range: string;
        let versionRef: string;
        if (isRecord(spec)) {
          range = spec.specifier === undefined ? '*' : String(spec.specifier);
          versionRef = spec.version === undefined ? '' : String(spec.version);
        } else {
          versionRef = String(spec);
          range = versionRef;
        }
        if (versionRef === '') continue;
        if (versionRef.startsWith('link:')) {
          warnings.push(
            `skipping workspace link ${depName} -> ${versionRef} (importer "${importerPath}")`,
          );
          continue;
        }
        const to = depTargetKey(depName, versionRef);
        if (!to || !packages.has(to)) {
          warnings.push(`root dependency ${depName}@${versionRef} not found in lockfile`);
          continue;
        }
        edges.push({ from: ROOT, to, type, range });
      }
    }
  }

  return finalizeGraph({
    lockfileType: 'pnpm',
    lockfileVersion,
    lockfilePath: ctx.lockfilePath,
    packages,
    edges,
    warnings,
  });
}

/* ------------------------------- helpers ------------------------------- */

function addDepEdges(
  from: PkgKey,
  value: Record<string, unknown>,
  edges: DependencyEdge[],
  packages: Map<PkgKey, ResolvedPackage>,
  warnings: string[],
): void {
  const sections: Array<[string, EdgeType]> = [
    ['dependencies', 'prod'],
    ['optionalDependencies', 'optional'],
  ];
  for (const [sectionName, type] of sections) {
    const section = value[sectionName];
    if (!isRecord(section)) continue;
    for (const [depName, ref] of Object.entries(section)) {
      const versionRef = String(ref);
      if (versionRef.startsWith('link:')) {
        warnings.push(`skipping workspace link ${depName} -> ${versionRef} (from ${from})`);
        continue;
      }
      const to = depTargetKey(depName, versionRef);
      if (!to || !packages.has(to)) {
        if (type !== 'optional') {
          warnings.push(`cannot resolve ${depName}@${versionRef} required by ${from}`);
        }
        continue;
      }
      edges.push({ from, to, type, range: versionRef });
    }
  }
}

/**
 * Parse a pnpm package/snapshot locator into name+version, stripping the
 * v6 leading slash and any peer-suffix parentheses:
 *   "/name@1.0.0(react@18.2.0)" | "name@1.0.0(react@18.2.0)" | "@s/n@1.0.0"
 */
function parseLocator(rawKey: string): { name: string; version: string } | null {
  let key = rawKey.startsWith('/') ? rawKey.slice(1) : rawKey;
  const paren = key.indexOf('(');
  if (paren !== -1) key = key.slice(0, paren);
  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

/**
 * Resolve a dependency value to a PkgKey. Values are usually bare
 * versions ("1.2.3", "1.2.3(react@18.2.0)"); aliased dependencies point
 * to a full locator ("/real-name@1.0.0" in v6, "real-name@1.0.0" in v9).
 */
function depTargetKey(name: string, versionRef: string): PkgKey | null {
  let ref = versionRef;
  if (ref.startsWith('/')) {
    const loc = parseLocator(ref);
    return loc ? makeKey(loc.name, loc.version) : null;
  }
  const paren = ref.indexOf('(');
  if (paren !== -1) ref = ref.slice(0, paren);
  const at = ref.lastIndexOf('@');
  if (at > 0) {
    // aliased dependency: value is itself a "name@version" locator
    return makeKey(ref.slice(0, at), ref.slice(at + 1));
  }
  return makeKey(name, ref);
}
