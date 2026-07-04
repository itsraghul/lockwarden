import { isSourcePath, pkgRef, textOf } from './shared.ts';
import type { Analyzer, FileEntry, Signal } from './types.ts';

/**
 * LW008 — phantom dependencies: declared in the manifest, never imported in
 * source. The plain-crypto-js pattern — a payload package staged as a
 * dependency purely so the install graph pulls it in.
 *
 * PACKAGE MODE: scans the package's own JS/TS files for its declared deps.
 * PROJECT MODE (ctx.project set): scans project sourceFiles for directDeps.
 *
 * Delta fact (spec §3 assigns phantom no delta weight, but analyzers emit
 * facts, not severities): a phantom dep NEWLY declared vs the previous
 * version is also reported so the corpus can calibrate whether it deserves
 * its own weight — a brand-new never-imported dep in a version bump is the
 * highest-precision variant of this signal.
 */

const SPECIFIER_RES = [
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bfrom\s+['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"\n]+)['"]/g,
];

function collectSpecifiers(text: string, into: Set<string>): void {
  for (const re of SPECIFIER_RES) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const spec = match[1];
      if (spec !== undefined) into.add(spec);
    }
  }
}

function referenced(dep: string, specifiers: ReadonlySet<string>): boolean {
  if (specifiers.has(dep)) return true;
  const prefix = `${dep}/`;
  for (const spec of specifiers) {
    if (spec.startsWith(prefix)) return true;
  }
  return false;
}

function depsOf(manifest: Record<string, unknown>): Map<string, string> {
  const deps = manifest.dependencies;
  const out = new Map<string, string>();
  if (deps !== null && typeof deps === 'object' && !Array.isArray(deps)) {
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range === 'string') out.set(name, range);
    }
  }
  return out;
}

async function specifiersOf(
  files: Iterable<FileEntry>,
): Promise<{ specs: Set<string>; jsFileCount: number }> {
  const specs = new Set<string>();
  let jsFileCount = 0;
  for (const entry of files) {
    if (!isSourcePath(entry.path)) continue;
    jsFileCount++;
    collectSpecifiers(await textOf(entry), specs);
  }
  return { specs, jsFileCount };
}

export const phantomDepsAnalyzer: Analyzer = {
  id: 'phantom-deps',
  scope: 'package',
  needsPrevious: false,
  needsProject: false,
  async analyze(ctx) {
    const signals: Signal[] = [];

    if (ctx.project !== undefined) {
      // PROJECT MODE
      const { specs, jsFileCount } = await specifiersOf(ctx.project.sourceFiles);
      if (jsFileCount === 0 || ctx.project.directDeps.size === 0) return signals;
      for (const [dep, range] of ctx.project.directDeps) {
        if (referenced(dep, specs)) continue;
        signals.push({
          analyzer: 'phantom-deps',
          code: 'LW008-PHANTOM',
          kind: 'absolute',
          package: { name: dep, version: range },
          evidence: {
            detail: `project declares direct dependency "${dep}" (${range}) but never imports it in ${jsFileCount} source files`,
          },
          metrics: { scannedFiles: jsFileCount },
        });
      }
      return signals;
    }

    // PACKAGE MODE
    const deps = depsOf(ctx.pkg.manifest);
    if (deps.size === 0) return signals;
    const { specs, jsFileCount } = await specifiersOf(ctx.pkg.files.values());
    if (jsFileCount === 0) return signals; // types-only / asset-only package

    const prevDeps = ctx.previous === undefined ? undefined : depsOf(ctx.previous.manifest);

    for (const [dep, range] of deps) {
      if (referenced(dep, specs)) continue;
      signals.push({
        analyzer: 'phantom-deps',
        code: 'LW008-PHANTOM',
        kind: 'absolute',
        package: pkgRef(ctx.pkg),
        evidence: {
          file: 'package.json',
          detail: `declared dependency "${dep}" (${range}) is never imported in ${jsFileCount} JS/TS files (plain-crypto-js pattern)`,
        },
        metrics: { scannedFiles: jsFileCount },
      });
      if (prevDeps !== undefined && !prevDeps.has(dep)) {
        signals.push({
          analyzer: 'phantom-deps',
          code: 'LW008D-PHANTOM-INTRODUCED',
          kind: 'delta',
          package: pkgRef(ctx.pkg),
          evidence: {
            file: 'package.json',
            detail: `never-imported dependency "${dep}" (${range}) is NEWLY declared in ${ctx.pkg.version} (absent in ${ctx.previous?.version})`,
          },
          metrics: { scannedFiles: jsFileCount },
        });
      }
    }
    return signals;
  },
};
