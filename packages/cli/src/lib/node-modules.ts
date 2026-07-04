import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Locate a resolved package's installed contents inside node_modules,
 * across the three real-world layouts:
 *
 *   1. hoisted / direct: <dir>/node_modules/<name>
 *   2. pnpm store:       <dir>/node_modules/.pnpm/<enc>@<ver>[peer-suffix]/
 *      node_modules/<name>   (scoped names pnpm-encoded: "@scope/pkg" → "@scope+pkg")
 *   3. nested fallback:  breadth-first walk of node_modules trees looking
 *      for <name>/package.json with a matching version (depth cap 4)
 *
 * Every candidate is verified against its package.json name+version — the
 * lockfile is the source of truth, and a hoisted different version of the
 * same name must never be analyzed in its place.
 */

const MAX_NESTED_DEPTH = 4;

async function manifestMatches(pkgDir: string, name: string, version: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const manifest = parsed as Record<string, unknown>;
    return manifest.name === name && manifest.version === version;
  } catch {
    return false;
  }
}

/** pnpm's store-directory encoding of a package name: "@scope/pkg" → "@scope+pkg". */
function pnpmEncode(name: string): string {
  return name.replace('/', '+');
}

/** Path segments of a package name under a node_modules dir (scoped-safe). */
function nameSegments(name: string): string[] {
  return name.split('/');
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Package directories directly inside one node_modules directory
 * (descends into @scope dirs; skips dotfiles like .bin/.pnpm).
 */
async function packageDirsIn(nodeModules: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await listDir(nodeModules)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      for (const scoped of await listDir(join(nodeModules, entry))) {
        if (!scoped.startsWith('.')) out.push(join(nodeModules, entry, scoped));
      }
    } else {
      out.push(join(nodeModules, entry));
    }
  }
  return out;
}

/**
 * Absolute path of the installed copy of name@version under <dir>, or null
 * when it is not on disk (skipped-optional, prod-pruned, not yet installed).
 */
export async function locateInstalled(
  dir: string,
  name: string,
  version: string,
): Promise<string | null> {
  const rootNm = join(dir, 'node_modules');

  // 1. hoisted / direct
  const direct = join(rootNm, ...nameSegments(name));
  if (await manifestMatches(direct, name, version)) return direct;

  // 2. pnpm store layout
  const pnpmDir = join(rootNm, '.pnpm');
  const prefix = `${pnpmEncode(name)}@${version}`;
  for (const entry of await listDir(pnpmDir)) {
    // exact, or with a peer-suffix: "name@1.0.0_react@18.2.0" / "name@1.0.0(react@18.2.0)"
    if (entry !== prefix && !entry.startsWith(`${prefix}_`) && !entry.startsWith(`${prefix}(`)) {
      continue;
    }
    const candidate = join(pnpmDir, entry, 'node_modules', ...nameSegments(name));
    if (await manifestMatches(candidate, name, version)) return candidate;
  }

  // 3. nested node_modules walk, breadth-first, depth-capped
  const queue: Array<{ nm: string; depth: number }> = [{ nm: rootNm, depth: 1 }];
  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    const candidate = join(item.nm, ...nameSegments(name));
    if (await manifestMatches(candidate, name, version)) return candidate;
    if (item.depth >= MAX_NESTED_DEPTH) continue;
    for (const pkgDir of await packageDirsIn(item.nm)) {
      const nested = join(pkgDir, 'node_modules');
      if ((await listDir(nested)).length > 0) {
        queue.push({ nm: nested, depth: item.depth + 1 });
      }
    }
  }

  return null;
}
