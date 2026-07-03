/**
 * yarn.lock v1 parser. The format is frozen and not YAML, so this is a
 * small custom line parser: comment/blank handling, entry headers of
 * comma-separated descriptors (quoted or bare), indented `version`,
 * `resolved`, `integrity` fields and nested `dependencies:` /
 * `optionalDependencies:` blocks.
 *
 * yarn v1 does not mark dev per entry — root edges come from the project
 * manifest, and finalizeGraph computes dev/optional via reachability.
 */
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
import { ROOT, makeKey, splitNameSpec } from './types.js';
import { manifestSection, semverFallback } from './util.js';

interface YarnEntry {
  descriptors: string[];
  name: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  deps: Array<{ name: string; range: string; type: 'prod' | 'optional' }>;
}

export function parseYarnClassic(content: string, ctx: ParseContext): ResolutionGraph {
  const warnings: string[] = [];
  const entries = lex(content, warnings);
  if (entries.length === 0 && content.trim().length > 0 && !content.includes('@')) {
    throw new ExecError(`${ctx.lockfilePath}: does not look like a yarn.lock v1 file`);
  }

  const packages = new Map<PkgKey, ResolvedPackage>();
  const keyByDescriptor = new Map<string, PkgKey>();
  const versionsByName = new Map<string, string[]>();
  const resolvedEntries: Array<{ key: PkgKey; entry: YarnEntry }> = [];

  for (const entry of entries) {
    if (!entry.version) {
      warnings.push(`yarn.lock entry "${entry.descriptors[0] ?? '?'}" has no version; skipped`);
      continue;
    }
    const key = makeKey(entry.name, entry.version);
    resolvedEntries.push({ key, entry });
    for (const descriptor of entry.descriptors) keyByDescriptor.set(descriptor, key);
    const versions = versionsByName.get(entry.name);
    if (versions) {
      if (!versions.includes(entry.version)) versions.push(entry.version);
    } else {
      versionsByName.set(entry.name, [entry.version]);
    }
    const existing = packages.get(key);
    if (existing) {
      for (const d of entry.descriptors) {
        if (!existing.locators.includes(d)) existing.locators.push(d);
      }
      existing.resolved ??= entry.resolved;
      existing.integrity ??= entry.integrity;
    } else {
      packages.set(key, {
        key,
        name: entry.name,
        version: entry.version,
        resolved: entry.resolved,
        integrity: entry.integrity,
        dev: false,
        optional: false,
        locators: [...entry.descriptors],
      });
    }
  }

  const resolve = (name: string, range: string): PkgKey | undefined =>
    keyByDescriptor.get(`${name}@${range}`) ?? semverFallback(versionsByName, name, range);

  const edges: DependencyEdge[] = [];

  const rootSections: Array<[Record<string, string> | undefined, EdgeType, boolean]> = [
    [manifestSection(ctx.rootManifest, 'dependencies'), 'prod', false],
    [manifestSection(ctx.rootManifest, 'devDependencies'), 'dev', false],
    [manifestSection(ctx.rootManifest, 'optionalDependencies'), 'optional', true],
  ];
  for (const [section, type, silent] of rootSections) {
    for (const [name, range] of Object.entries(section ?? {})) {
      const to = resolve(name, range);
      if (to) edges.push({ from: ROOT, to, type, range });
      else if (!silent) warnings.push(`root dependency ${name}@${range} not found in yarn.lock`);
    }
  }

  for (const { key, entry } of resolvedEntries) {
    for (const dep of entry.deps) {
      const to = resolve(dep.name, dep.range);
      if (to) edges.push({ from: key, to, type: dep.type, range: dep.range });
      else if (dep.type !== 'optional') {
        warnings.push(`cannot resolve ${dep.name}@${dep.range} required by ${key}`);
      }
    }
  }

  return finalizeGraph({
    lockfileType: 'yarn-classic',
    lockfileVersion: '1',
    lockfilePath: ctx.lockfilePath,
    packages,
    edges,
    warnings,
  });
}

/* -------------------------------- lexer -------------------------------- */

function lex(content: string, warnings: string[]): YarnEntry[] {
  const entries: YarnEntry[] = [];
  let current: YarnEntry | null = null;
  let section: 'none' | 'dependencies' | 'optionalDependencies' = 'none';

  for (const raw of content.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    if (raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (indent === 0) {
      section = 'none';
      if (!line.endsWith(':')) {
        warnings.push(`yarn.lock: unexpected top-level line "${line}"`);
        current = null;
        continue;
      }
      const descriptors = splitDescriptors(line.slice(0, -1));
      const first = descriptors[0];
      if (!first) {
        warnings.push('yarn.lock: entry header with no descriptors');
        current = null;
        continue;
      }
      const { name } = splitNameSpec(first);
      current = { descriptors, name, deps: [] };
      entries.push(current);
    } else if (indent === 2) {
      if (!current) continue;
      if (line === 'dependencies:') {
        section = 'dependencies';
        continue;
      }
      if (line === 'optionalDependencies:') {
        section = 'optionalDependencies';
        continue;
      }
      section = 'none';
      const [k, v] = splitKeyValue(line);
      if (v === undefined) continue;
      if (k === 'version') current.version = v;
      else if (k === 'resolved') current.resolved = v;
      else if (k === 'integrity') current.integrity = v;
    } else if (indent >= 4) {
      if (!current || section === 'none') continue;
      const [k, v] = splitKeyValue(line);
      if (v === undefined) continue;
      current.deps.push({
        name: k,
        range: v,
        type: section === 'dependencies' ? 'prod' : 'optional',
      });
    }
  }
  return entries;
}

/** Split `"a@^1.0.0", "a@^1.2.0"` into descriptors, respecting quotes. */
function splitDescriptors(header: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of header) {
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === ',' && !inQuote) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** `version "1.2.3"` / `"@scope/x" "^1.0.0"` / `integrity sha512-...` (unquoted value). */
function splitKeyValue(line: string): [string, string | undefined] {
  let key: string;
  let rest: string;
  if (line.startsWith('"')) {
    const end = line.indexOf('"', 1);
    if (end === -1) return [line, undefined];
    key = line.slice(1, end);
    rest = line.slice(end + 1).trim();
  } else {
    const space = line.indexOf(' ');
    if (space === -1) return [line, undefined];
    key = line.slice(0, space);
    rest = line.slice(space + 1).trim();
  }
  if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) {
    rest = rest.slice(1, -1);
  }
  return [key, rest];
}
