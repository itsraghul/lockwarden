/**
 * Lockfile discovery + top-level entry points.
 *
 * detectLockfile(dir)        -> which lockfile governs this project
 * parseLockfileContent(...)  -> parse a lockfile from a string (used by
 *                               `check --history` to reparse historical
 *                               contents pulled from git)
 * loadGraph(dir)             -> detect + read + parse, built on the above
 *
 * All failures that should terminate the CLI raise ExecError (exit 2).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ExecError } from '../exit.js';
import { parseBun } from './bun.js';
import { parseNpm } from './npm.js';
import { parsePnpm } from './pnpm.js';
import type { LockfileType, ParseContext, ResolutionGraph } from './types.js';
import { errorMessage, isRecord } from './util.js';
import { parseYarnBerry } from './yarn-berry.js';
import { parseYarnClassic } from './yarn-classic.js';

export interface DetectedLockfile {
  path: string;
  type: LockfileType;
  /** Set when multiple lockfiles were present and one had to be chosen. */
  warning?: string;
}

const CANDIDATES: ReadonlyArray<{ file: string; type: LockfileType; manager: string }> = [
  { file: 'package-lock.json', type: 'npm', manager: 'npm' },
  { file: 'pnpm-lock.yaml', type: 'pnpm', manager: 'pnpm' },
  { file: 'yarn.lock', type: 'yarn-classic', manager: 'yarn' },
  { file: 'bun.lock', type: 'bun', manager: 'bun' },
];

export function detectLockfile(dir: string): DetectedLockfile | null {
  const present = CANDIDATES.filter((c) => existsSync(join(dir, c.file)));
  const first = present[0];
  if (!first) return null;

  let chosen = first;
  let warning: string | undefined;
  if (present.length > 1) {
    const names = present.map((p) => p.file).join(', ');
    const manager = readPackageManager(dir);
    const byManager = manager ? present.find((p) => p.manager === manager) : undefined;
    if (byManager) {
      chosen = byManager;
      warning = `multiple lockfiles found (${names}); using ${byManager.file} (matches packageManager)`;
    } else {
      let bestMtime = -1;
      for (const candidate of present) {
        const mtime = mtimeOf(join(dir, candidate.file));
        if (mtime > bestMtime) {
          bestMtime = mtime;
          chosen = candidate;
        }
      }
      warning = `multiple lockfiles found (${names}); using ${chosen.file} (most recently modified)`;
    }
  }

  const path = join(dir, chosen.file);
  const type = chosen.file === 'yarn.lock' ? sniffYarnType(path) : chosen.type;
  return warning ? { path, type, warning } : { path, type };
}

/**
 * Parse lockfile CONTENT of a known type — no filesystem access. This is
 * the dispatcher `check --history` uses to reparse historical lockfile
 * blobs pulled from git.
 */
export function parseLockfileContent(
  content: string,
  type: LockfileType,
  ctx: ParseContext,
): ResolutionGraph {
  try {
    switch (type) {
      case 'npm':
        return parseNpm(content, ctx);
      case 'yarn-classic':
        return parseYarnClassic(content, ctx);
      case 'yarn-berry':
        return parseYarnBerry(content, ctx);
      case 'pnpm':
        return parsePnpm(content, ctx);
      case 'bun':
        return parseBun(content, ctx);
    }
  } catch (err) {
    if (err instanceof ExecError) throw err;
    throw new ExecError(`failed to parse ${ctx.lockfilePath}: ${errorMessage(err)}`);
  }
}

export function loadGraph(dir: string): ResolutionGraph {
  const detected = detectLockfile(dir);
  if (!detected) {
    if (existsSync(join(dir, 'bun.lockb'))) {
      throw new ExecError(
        `only a binary bun.lockb found in ${dir}`,
        'Generate the textual lockfile with `bun install --save-text-lockfile`, then re-run.',
      );
    }
    throw new ExecError(
      `no lockfile found in ${dir}`,
      'Expected package-lock.json, pnpm-lock.yaml, yarn.lock, or bun.lock. The lockfile is the source of truth.',
    );
  }

  let content: string;
  try {
    content = readFileSync(detected.path, 'utf8');
  } catch (err) {
    throw new ExecError(`cannot read ${detected.path}: ${errorMessage(err)}`);
  }

  let rootManifest: Record<string, unknown> | undefined;
  let manifestWarning: string | undefined;
  const manifestPath = join(dir, 'package.json');
  if (existsSync(manifestPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (isRecord(parsed)) rootManifest = parsed;
    } catch (err) {
      manifestWarning = `cannot parse ${manifestPath} (${errorMessage(err)}); root edge classification may be incomplete`;
    }
  }

  const graph = parseLockfileContent(content, detected.type, {
    lockfilePath: detected.path,
    rootManifest,
  });
  if (detected.warning) graph.warnings.push(detected.warning);
  if (manifestWarning) graph.warnings.push(manifestWarning);
  return graph;
}

/* ------------------------------- helpers ------------------------------- */

function sniffYarnType(path: string): LockfileType {
  try {
    const head = readFileSync(path, 'utf8');
    return /^__metadata:/m.test(head) ? 'yarn-berry' : 'yarn-classic';
  } catch {
    return 'yarn-classic';
  }
}

function readPackageManager(dir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (!isRecord(parsed) || typeof parsed.packageManager !== 'string') return null;
    const field = parsed.packageManager;
    const at = field.indexOf('@');
    return at === -1 ? field : field.slice(0, at);
  } catch {
    return null;
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}
