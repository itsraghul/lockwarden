import type { FileEntry, PackageArtifact, Signal } from './types.ts';

/** Helpers shared by the corpus-born analyzers. Zero severity knowledge here. */

export function pkgRef(pkg: PackageArtifact): Signal['package'] {
  return { name: pkg.name, version: pkg.version };
}

/** The four lifecycle hooks npm runs without being asked. */
export const LIFECYCLE_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare'] as const;

export function manifestScripts(pkg: PackageArtifact): Record<string, string> {
  const scripts = pkg.manifest.scripts;
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export function isJsPath(path: string): boolean {
  return /\.(?:js|cjs|mjs)$/i.test(path);
}

export function isSourcePath(path: string): boolean {
  return /\.(?:js|cjs|mjs|ts|cts|mts)$/i.test(path);
}

function normalizeRel(p: string): string {
  let out = p;
  while (out.startsWith('./')) out = out.slice(2);
  return out;
}

/** Look a manifest-declared path up in the files map, npm-resolution style. */
export function resolveFile(pkg: PackageArtifact, declared: string): FileEntry | undefined {
  const p = normalizeRel(declared);
  return (
    pkg.files.get(p) ??
    pkg.files.get(`${p}.js`) ??
    pkg.files.get(`${p}.cjs`) ??
    pkg.files.get(`${p}.mjs`) ??
    pkg.files.get(`${p}/index.js`)
  );
}

function firstStringExport(exportsField: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof exportsField === 'string') {
    return /\.(?:js|cjs|mjs)$/i.test(exportsField) ? exportsField : undefined;
  }
  if (exportsField !== null && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    for (const value of Object.values(exportsField)) {
      const hit = firstStringExport(value, depth + 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/**
 * Resolve the package's main entry file: manifest.main, else index.js,
 * else the first `exports` entry that is a string ending .js/.cjs/.mjs.
 */
export function resolveMainEntry(pkg: PackageArtifact): FileEntry | undefined {
  const main = pkg.manifest.main;
  if (typeof main === 'string' && main !== '') {
    const hit = resolveFile(pkg, main);
    if (hit !== undefined) return hit;
  }
  const index = pkg.files.get('index.js');
  if (index !== undefined) return index;
  const fromExports = firstStringExport(pkg.manifest.exports);
  if (fromExports !== undefined) return resolveFile(pkg, fromExports);
  return undefined;
}

export async function textOf(entry: FileEntry): Promise<string> {
  return (await entry.read()).toString('utf8');
}
