/**
 * bun.lock parser (Bun ≥1.2 textual lockfile). The file is JSONC — Bun writes
 * trailing commas and tolerates comments — so parsing goes through a small
 * string-aware stripper first.
 *
 * Shape (lockfileVersion 0/1):
 *   workspaces: { "": {name, dependencies, devDependencies, …}, "<path>": {…} }
 *   packages:   { "<nesting path>": [ "name@version", "<registry>", {meta}, "sha512-…" ] }
 *
 * Nesting paths work like npm's node_modules nesting with the "node_modules/"
 * prefix removed: "send/debug" is the debug resolved under send when the
 * hoisted "debug" is a different version. Edge resolution therefore walks up
 * the path exactly like the Node resolver (scope-aware: "@scope/name" is one
 * segment). Workspace stubs ("name@workspace:path") are skipped like npm's
 * link stubs — workspace packages are not modeled.
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
import { ROOT, makeKey, splitNameSpec } from './types.js';
import { errorMessage, isRecord, manifestSection } from './util.js';

interface BunMeta {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export function parseBun(content: string, ctx: ParseContext): ResolutionGraph {
  let doc: unknown;
  try {
    doc = JSON.parse(stripJsonc(content));
  } catch (err) {
    throw new ExecError(`${ctx.lockfilePath}: invalid JSONC — ${errorMessage(err)}`);
  }
  if (!isRecord(doc)) {
    throw new ExecError(`${ctx.lockfilePath}: expected a JSONC object`);
  }

  const lockfileVersion = String(doc.lockfileVersion ?? '0');
  const warnings: string[] = [];
  const rawPackages = isRecord(doc.packages) ? doc.packages : {};
  const workspaces = isRecord(doc.workspaces) ? doc.workspaces : {};

  const byPath = new Map<string, { key: PkgKey; meta: BunMeta }>();
  const packages = new Map<PkgKey, ResolvedPackage>();
  const edges: DependencyEdge[] = [];
  let workspacesSkipped = false;

  for (const [path, raw] of Object.entries(rawPackages)) {
    if (!Array.isArray(raw) || typeof raw[0] !== 'string') {
      warnings.push(`skipping "${path}": unrecognized entry shape`);
      continue;
    }
    const { name, spec } = splitNameSpec(raw[0]);
    if (spec === null) {
      warnings.push(`skipping "${path}": no version in "${raw[0]}"`);
      continue;
    }
    if (spec.startsWith('workspace:')) {
      workspacesSkipped = true;
      continue;
    }
    // Registry entries: ["name@version", "<registry>", {meta}, "sha…"]. Git/
    // tarball tuples differ in length, so locate the parts structurally.
    const meta = (raw.slice(1).find((element) => isRecord(element)) ?? {}) as BunMeta;
    const integrity = [...raw]
      .reverse()
      .find((element): element is string => typeof element === 'string' && /^sha\d/.test(element));
    const registry = typeof raw[1] === 'string' && raw[1] !== '' ? raw[1] : undefined;

    const key = makeKey(name, spec);
    byPath.set(path, { key, meta });
    const existing = packages.get(key);
    if (existing) {
      existing.locators.push(path);
      existing.resolved ??= registry;
      existing.integrity ??= integrity;
    } else {
      packages.set(key, {
        key,
        name,
        version: spec,
        resolved: registry,
        integrity,
        dev: false,
        optional: false,
        locators: [path],
      });
    }
  }
  if (workspacesSkipped) {
    warnings.push('workspace packages present; their dependency edges are not modeled');
  }

  const addEdges = (
    fromPath: string,
    from: PkgKey | RootMarker,
    deps: unknown,
    type: EdgeType,
    silentWhenMissing: boolean,
  ): void => {
    if (!isRecord(deps)) return;
    for (const [depName, range] of Object.entries(deps)) {
      const targetPath = resolveDepPath(fromPath, depName, byPath);
      if (targetPath === undefined) {
        if (!silentWhenMissing) {
          warnings.push(`cannot resolve ${depName}@${String(range)} from "${fromPath || ROOT}"`);
        }
        continue;
      }
      const target = byPath.get(targetPath);
      if (target) edges.push({ from, to: target.key, type, range: String(range) });
    }
  };

  // Root edges come from the "" workspace; the manifest is only a fallback.
  const rootWorkspace = isRecord(workspaces['']) ? workspaces[''] : {};
  const manifest = ctx.rootManifest;
  addEdges(
    '',
    ROOT,
    rootWorkspace.dependencies ?? manifestSection(manifest, 'dependencies'),
    'prod',
    false,
  );
  addEdges(
    '',
    ROOT,
    rootWorkspace.devDependencies ?? manifestSection(manifest, 'devDependencies'),
    'dev',
    false,
  );
  addEdges(
    '',
    ROOT,
    rootWorkspace.optionalDependencies ?? manifestSection(manifest, 'optionalDependencies'),
    'optional',
    true,
  );
  addEdges(
    '',
    ROOT,
    rootWorkspace.peerDependencies ?? manifestSection(manifest, 'peerDependencies'),
    'peer',
    true,
  );

  for (const [path, { key, meta }] of byPath) {
    addEdges(path, key, meta.dependencies, 'prod', false);
    addEdges(path, key, meta.optionalDependencies, 'optional', true);
    addEdges(path, key, meta.peerDependencies, 'peer', true);
  }

  const draft: GraphDraft = {
    lockfileType: 'bun',
    lockfileVersion,
    lockfilePath: ctx.lockfilePath,
    packages,
    edges,
    warnings,
  };
  return finalizeGraph(draft);
}

/* ------------------------------ resolution ------------------------------ */

/** Split a nesting path into name segments; "@scope/name" is one segment. */
function segmentsOf(path: string): string[] {
  const tokens = path.split('/');
  const segments: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token.startsWith('@') && i + 1 < tokens.length) {
      segments.push(`${token}/${tokens[i + 1]}`);
      i += 1;
    } else {
      segments.push(token);
    }
  }
  return segments;
}

/** Deepest install of `name` walking up the nesting from `fromPath`. */
function resolveDepPath(
  fromPath: string,
  name: string,
  byPath: Map<string, unknown>,
): string | undefined {
  const segments = fromPath === '' ? [] : segmentsOf(fromPath);
  for (let depth = segments.length; depth >= 0; depth -= 1) {
    const prefix = segments.slice(0, depth).join('/');
    const candidate = prefix === '' ? name : `${prefix}/${name}`;
    if (byPath.has(candidate)) return candidate;
  }
  return undefined;
}

/* -------------------------------- JSONC --------------------------------- */

/**
 * Strip comments and trailing commas outside string literals. Bun always
 * writes trailing commas; comments survive hand edits since Bun reads JSONC.
 */
export function stripJsonc(content: string): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < content.length) {
    const char = content[i] as string;
    if (inString) {
      out += char;
      if (char === '\\' && i + 1 < content.length) {
        out += content[i + 1];
        i += 2;
        continue;
      }
      if (char === '"') inString = false;
      i += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      i += 1;
      continue;
    }
    if (char === '/' && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') i += 1;
      continue;
    }
    if (char === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (char === ',') {
      // Trailing comma: next non-whitespace/non-comment char closes a scope.
      let j = i + 1;
      for (;;) {
        while (j < content.length && /\s/.test(content[j] as string)) j += 1;
        if (content[j] === '/' && content[j + 1] === '/') {
          while (j < content.length && content[j] !== '\n') j += 1;
          continue;
        }
        if (content[j] === '/' && content[j + 1] === '*') {
          j += 2;
          while (j < content.length && !(content[j] === '*' && content[j + 1] === '/')) j += 1;
          j += 2;
          continue;
        }
        break;
      }
      if (content[j] === '}' || content[j] === ']') {
        i += 1; // drop the comma; the scanner re-handles what follows
        continue;
      }
    }
    out += char;
    i += 1;
  }
  return out;
}
