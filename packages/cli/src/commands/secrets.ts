import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { ExecError, ExitCode } from '../exit.js';
import type { GlobalOptions } from '../index.js';
import { bad, configureOutput, dim, ok, printJson, warn } from '../lib/output.js';
import { type SecretMatch, scanContent } from '../lib/secret-rules.js';
import { parseThreshold } from '../scoring/threshold.js';
import { SEV_RANK, type Severity } from '../scoring/weights.js';

interface SecretFinding extends SecretMatch {
  /** Posix-style path relative to the scanned dir. */
  file: string;
  /** Owning node_modules package, when found on a dependency install path. */
  package?: string;
}

interface ScanStats {
  files: number;
  packages: number;
}

/** Skipped during the project walk (spec §2.5): installed deps get their own targeted pass. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const;
/** File-looking tokens inside lifecycle script bodies (same shape as the obfuscation analyzer). */
const SCRIPT_FILE_TOKEN_RE = /[\w@./-]+\.(?:cjs|mjs|js|sh)\b/g;

/**
 * `secrets` has no command-specific flags: --dir/--json/--ci/--threshold are
 * global, so the command body takes the merged globals directly.
 */
export async function runSecrets(globals: GlobalOptions): Promise<number> {
  configureOutput({ json: globals.json, ci: globals.ci });
  const threshold = parseThreshold(globals.threshold);
  const dirs = globals.dir.length > 0 ? globals.dir : [process.cwd()];

  const stats: ScanStats = { files: 0, packages: 0 };
  const findings: SecretFinding[] = [];
  const warnings: string[] = [];

  for (const dir of dirs) {
    const root = resolve(dir);
    let rootStat: Awaited<ReturnType<typeof stat>>;
    try {
      rootStat = await stat(root);
    } catch {
      throw new ExecError(`cannot scan ${dir}: no such directory`);
    }
    if (!rootStat.isDirectory()) {
      throw new ExecError(`cannot scan ${dir}: not a directory`);
    }
    // With multiple --dir roots, prefix so findings stay unambiguous.
    const prefix = dirs.length > 1 ? toPosix(relative(process.cwd(), root) || root) : '';
    await walkProject(root, prefix, stats, findings, warnings);
    await scanDependencies(root, prefix, stats, findings, warnings);
  }

  sortFindings(findings);
  const floor = SEV_RANK[threshold];
  const exitCode = findings.some((f) => SEV_RANK[f.severity] >= floor)
    ? ExitCode.Findings
    : ExitCode.Clean;

  if (globals.json) {
    printJson({
      command: 'secrets',
      scanned: { files: stats.files, packages: stats.packages },
      findings: findings.map((f) => ({
        file: f.file,
        line: f.line,
        ruleId: f.ruleId,
        ruleName: f.ruleName,
        severity: f.severity,
        excerpt: f.excerpt,
        ...(f.package === undefined ? {} : { package: f.package }),
      })),
      warnings,
      exitCode,
    });
    return exitCode;
  }

  renderHuman(findings, stats, warnings, globals);
  return exitCode;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function fileLabel(root: string, abs: string, prefix: string): string {
  const rel = toPosix(relative(root, abs));
  return prefix === '' ? rel : `${prefix}/${rel}`;
}

/**
 * Scan one file if it looks like text: skip anything over 1 MB or with a NUL
 * byte in the first 8 KB. Returns null when skipped/unreadable.
 */
async function scanFile(abs: string): Promise<SecretMatch[] | null> {
  try {
    const st = await stat(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const buf = await readFile(abs);
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
    return scanContent(buf.toString('utf8'));
  } catch {
    return null; // unreadable file: skip, never abort the whole scan
  }
}

/** Walk project source files under root, skipping SKIP_DIRS; cap at MAX_FILES. */
async function walkProject(
  root: string,
  prefix: string,
  stats: ScanStats,
  findings: SecretFinding[],
  warnings: string[],
): Promise<void> {
  const queue: string[] = [root];
  let capped = false;
  while (queue.length > 0 && !capped) {
    const current = queue.shift();
    if (current === undefined) break;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue; // unreadable subdirectory: skip
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(abs);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks etc.
      if (stats.files >= MAX_FILES) {
        capped = true;
        warnings.push(`file cap reached (${MAX_FILES}); remaining project files were not scanned`);
        break;
      }
      const matches = await scanFile(abs);
      if (matches === null) continue;
      stats.files += 1;
      for (const m of matches) findings.push({ ...m, file: fileLabel(root, abs, prefix) });
    }
  }
}

/**
 * Dependency install-path pass: for every package.json directly under
 * node_modules (depth ≤ 2, i.e. including @scope/pkg), scan ONLY the files
 * its lifecycle scripts reference plus its main entry — the surface that
 * executes at install/import time, not all of node_modules.
 */
async function scanDependencies(
  root: string,
  prefix: string,
  stats: ScanStats,
  findings: SecretFinding[],
  warnings: string[],
): Promise<void> {
  const nm = join(root, 'node_modules');
  const pkgDirs: string[] = [];
  for (const entry of await listDir(nm)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      for (const scoped of await listDir(join(nm, entry))) {
        if (!scoped.startsWith('.')) pkgDirs.push(join(nm, entry, scoped));
      }
    } else {
      pkgDirs.push(join(nm, entry));
    }
  }
  pkgDirs.sort();

  for (const pkgDir of pkgDirs) {
    let manifest: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      manifest = parsed as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        warnings.push(`skipping ${toPosix(relative(root, pkgDir))}: unreadable package.json`);
      }
      continue;
    }
    stats.packages += 1;
    const pkgName =
      typeof manifest.name === 'string' ? manifest.name : toPosix(relative(nm, pkgDir));

    const targets = new Set<string>();
    const addWithin = (token: string): void => {
      const candidate = resolve(pkgDir, token);
      if (candidate === pkgDir || !candidate.startsWith(pkgDir + sep)) return; // traversal guard
      targets.add(candidate);
    };
    const scripts =
      manifest.scripts !== null && typeof manifest.scripts === 'object'
        ? (manifest.scripts as Record<string, unknown>)
        : {};
    for (const key of LIFECYCLE_SCRIPTS) {
      const body = scripts[key];
      if (typeof body !== 'string') continue;
      for (const match of body.matchAll(SCRIPT_FILE_TOKEN_RE)) addWithin(match[0]);
    }
    addWithin(typeof manifest.main === 'string' ? manifest.main : 'index.js');

    for (const abs of [...targets].sort()) {
      const matches = await scanFile(abs);
      if (matches === null) continue;
      stats.files += 1;
      for (const m of matches) {
        findings.push({ ...m, file: fileLabel(root, abs, prefix), package: pkgName });
      }
    }
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return []; // no node_modules — nothing installed to scan
  }
}

const SEV_ORDER: Severity[] = ['critical', 'high', 'med', 'low'];

function sortFindings(findings: SecretFinding[]): void {
  findings.sort(
    (a, b) =>
      SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.ruleId.localeCompare(b.ruleId),
  );
}

function sevTag(severity: Severity): string {
  switch (severity) {
    case 'critical':
    case 'high':
      return bad(severity.toUpperCase().padEnd(4));
    case 'med':
      return warn('MED ');
    default:
      return dim('LOW ');
  }
}

function renderHuman(
  findings: SecretFinding[],
  stats: ScanStats,
  warnings: string[],
  globals: GlobalOptions,
): void {
  if (globals.ci) {
    const counts = SEV_ORDER.map(
      (sev) => `${findings.filter((f) => f.severity === sev).length} ${sev}`,
    ).join(', ');
    console.log(`secrets: ${counts} (${stats.files} files, ${stats.packages} packages scanned)`);
    return;
  }

  console.log(dim(`scanned ${stats.files} files, ${stats.packages} node_modules packages`));
  for (const warning of warnings) console.log(`  ${dim(`warning: ${warning}`)}`);
  if (findings.length === 0) {
    console.log(`  ${ok('clean')}  no hardcoded secrets found`);
    return;
  }
  for (const sev of SEV_ORDER) {
    for (const f of findings.filter((x) => x.severity === sev)) {
      const pkgTag = f.package === undefined ? '' : dim(` [${f.package}]`);
      console.log(
        `  ${sevTag(f.severity)}  ${f.file}:${f.line}  ${f.ruleName}  ${dim(f.excerpt)}${pkgTag}`,
      );
    }
  }
}
