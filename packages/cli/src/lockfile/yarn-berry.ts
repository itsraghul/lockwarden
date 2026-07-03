/**
 * yarn.lock (berry, v2+) parser. Berry lockfiles are YAML with a
 * `__metadata:` block. Keys are comma-joined descriptors like
 * `"lodash@npm:^4.17.21"`; the project root is the `<name>@workspace:.`
 * entry. `npm:` protocol prefixes are stripped when matching dependency
 * ranges; `patch:` descriptors are unwrapped to their inner npm
 * descriptor where feasible.
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
import { errorMessage, isRecord, manifestSection, semverFallback } from './util.js';

interface Descriptor {
  raw: string;
  name: string;
  protocol: string;
  range: string;
}

interface BerryEntry {
  descriptors: Descriptor[];
  name: string;
  version: string;
  resolution?: string;
  checksum?: string;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  isRootWorkspace: boolean;
}

export function parseYarnBerry(content: string, ctx: ParseContext): ResolutionGraph {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch (err) {
    throw new ExecError(`${ctx.lockfilePath}: invalid YAML — ${errorMessage(err)}`);
  }
  if (!isRecord(doc) || !isRecord(doc.__metadata)) {
    throw new ExecError(
      `${ctx.lockfilePath}: missing __metadata block (not a yarn berry lockfile)`,
    );
  }
  const lockfileVersion = String(doc.__metadata.version ?? 'unknown');
  const warnings: string[] = [];

  const entries: BerryEntry[] = [];
  for (const [rawKey, value] of Object.entries(doc)) {
    if (rawKey === '__metadata' || !isRecord(value)) continue;
    const descriptors = rawKey
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(parseDescriptor);
    const first = descriptors[0];
    if (!first) continue;
    if (value.version === undefined) {
      warnings.push(`yarn.lock entry "${rawKey}" has no version; skipped`);
      continue;
    }
    entries.push({
      descriptors,
      name: first.name,
      version: String(value.version),
      resolution: value.resolution === undefined ? undefined : String(value.resolution),
      checksum: value.checksum === undefined ? undefined : String(value.checksum),
      dependencies: isRecord(value.dependencies)
        ? (value.dependencies as Record<string, string>)
        : {},
      peerDependencies: isRecord(value.peerDependencies)
        ? (value.peerDependencies as Record<string, string>)
        : {},
      isRootWorkspace: descriptors.some((d) => d.protocol === 'workspace' && d.range === '.'),
    });
  }

  const packages = new Map<PkgKey, ResolvedPackage>();
  const keyByDescriptor = new Map<string, PkgKey>();
  const versionsByName = new Map<string, string[]>();

  for (const entry of entries) {
    if (entry.isRootWorkspace) continue;
    const key = makeKey(entry.name, entry.version);
    for (const d of entry.descriptors) {
      keyByDescriptor.set(d.raw, key);
      keyByDescriptor.set(`${d.name}@${d.range}`, key);
      if (d.protocol === 'npm') keyByDescriptor.set(`${d.name}@npm:${d.range}`, key);
    }
    const versions = versionsByName.get(entry.name);
    if (versions) {
      if (!versions.includes(entry.version)) versions.push(entry.version);
    } else {
      versionsByName.set(entry.name, [entry.version]);
    }
    const locators = [
      ...(entry.resolution ? [entry.resolution] : []),
      ...entry.descriptors.map((d) => d.raw),
    ];
    const existing = packages.get(key);
    if (existing) {
      for (const locator of locators) {
        if (!existing.locators.includes(locator)) existing.locators.push(locator);
      }
      existing.integrity ??= entry.checksum;
    } else {
      packages.set(key, {
        key,
        name: entry.name,
        version: entry.version,
        integrity: entry.checksum,
        dev: false,
        optional: false,
        locators,
      });
    }
  }

  const resolve = (name: string, rawRange: string): PkgKey | undefined => {
    let range = rawRange;
    if (range.startsWith('patch:')) {
      const inner = unwrapPatch(range);
      if (inner === undefined) {
        warnings.push(`cannot unwrap patch descriptor "${name}@${rawRange}"`);
        return undefined;
      }
      range = inner.includes('@') ? inner.slice(inner.indexOf('@', 1) + 1) : inner;
      // inner is a full descriptor like "typescript@npm:5.3.3"
      const direct = keyByDescriptor.get(inner);
      if (direct) return direct;
    }
    const bare = range.startsWith('npm:') ? range.slice(4) : range;
    return (
      keyByDescriptor.get(`${name}@npm:${bare}`) ??
      keyByDescriptor.get(`${name}@${bare}`) ??
      keyByDescriptor.get(`${name}@${rawRange}`) ??
      semverFallback(versionsByName, name, bare)
    );
  };

  const edges: DependencyEdge[] = [];
  const root = entries.find((e) => e.isRootWorkspace);
  if (root) {
    const devNames = new Set(
      Object.keys(manifestSection(ctx.rootManifest, 'devDependencies') ?? {}),
    );
    const optionalNames = new Set(
      Object.keys(manifestSection(ctx.rootManifest, 'optionalDependencies') ?? {}),
    );
    // Without a manifest, everything from the workspace entry is treated as
    // prod — berry merges devDependencies into the workspace `dependencies`.
    for (const [name, range] of Object.entries(root.dependencies)) {
      const to = resolve(name, String(range));
      if (!to) {
        warnings.push(`root dependency ${name}@${range} not found in yarn.lock`);
        continue;
      }
      const type: EdgeType = devNames.has(name)
        ? 'dev'
        : optionalNames.has(name)
          ? 'optional'
          : 'prod';
      edges.push({ from: ROOT, to, type, range: String(range) });
    }
  } else {
    warnings.push('no "<name>@workspace:." entry found; root edges unavailable');
  }

  for (const entry of entries) {
    if (entry.isRootWorkspace) continue;
    const from = makeKey(entry.name, entry.version);
    for (const [name, range] of Object.entries(entry.dependencies)) {
      const to = resolve(name, String(range));
      if (to) edges.push({ from, to, type: 'prod', range: String(range) });
      else warnings.push(`cannot resolve ${name}@${range} required by ${from}`);
    }
    for (const [name, range] of Object.entries(entry.peerDependencies)) {
      const to = resolve(name, String(range));
      if (to) edges.push({ from, to, type: 'peer', range: String(range) });
    }
  }

  return finalizeGraph({
    lockfileType: 'yarn-berry',
    lockfileVersion,
    lockfilePath: ctx.lockfilePath,
    packages,
    edges,
    warnings,
  });
}

/** "@babel/core@npm:^7.0.0" -> { name: "@babel/core", protocol: "npm", range: "^7.0.0" } */
function parseDescriptor(raw: string): Descriptor {
  const at = raw.startsWith('@') ? raw.indexOf('@', 1) : raw.indexOf('@');
  if (at <= 0) return { raw, name: raw, protocol: 'npm', range: '' };
  const name = raw.slice(0, at);
  const rest = raw.slice(at + 1);
  const match = /^([a-z-]+):([\s\S]*)$/.exec(rest);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return { raw, name, protocol: match[1], range: match[2] };
  }
  return { raw, name, protocol: 'npm', range: rest };
}

/** "patch:typescript@npm%3A5.3.3#optional!builtin<...>" -> "typescript@npm:5.3.3" */
function unwrapPatch(range: string): string | undefined {
  const body = range.slice('patch:'.length);
  const hash = body.indexOf('#');
  const inner = hash === -1 ? body : body.slice(0, hash);
  try {
    return decodeURIComponent(inner);
  } catch {
    return undefined;
  }
}
