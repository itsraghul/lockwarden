import type {
  Analyzer,
  PackageArtifact,
  Signal,
} from '../../../packages/cli/src/analyzers/types.ts';
import { excerpt } from '../../../packages/cli/src/analyzers/types.ts';
import { manifestScripts, pkgRef } from './shared.ts';

/**
 * LW009 — prebuilt native-binary surface: shipped `.node` binaries and
 * prebuilt-binary fetcher toolchains (prebuild-install, node-pre-gyp,
 * node-gyp-build, prebuildify) in runtime deps or lifecycle scripts.
 * A shipped `.node` file runs native code at require-time with NO
 * binding.gyp and possibly no lifecycle script — surface LW001/LW002
 * cannot see. Legitimate native packages carry this forever — the delta
 * signal (newly appeared) is what matters.
 *
 * v1 is listing+manifest only (zero file reads). Magic-byte sniffing of
 * `.node` entries (ELF/Mach-O/PE) is a possible future metrics-only
 * refinement; it would force decoding tar entries, so it stays out until
 * calibration shows it pays for itself.
 */

/** Longest-first so `@mapbox/node-pre-gyp` wins over its `node-pre-gyp` substring. */
const FETCHER_TOKENS = [
  '@mapbox/node-pre-gyp',
  'prebuild-install',
  'node-gyp-build',
  'node-pre-gyp',
  'prebuildify',
] as const;

interface NativeSurface {
  nodeFiles: string[];
  fetcherDeps: string[];
  scriptFetcher?: string;
}

function fetcherDepsOf(pkg: PackageArtifact): string[] {
  const out: string[] = [];
  for (const field of ['dependencies', 'optionalDependencies'] as const) {
    const deps = pkg.manifest[field];
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) continue;
    for (const name of Object.keys(deps)) {
      if ((FETCHER_TOKENS as readonly string[]).includes(name) && !out.includes(name)) {
        out.push(name);
      }
    }
  }
  return out;
}

function nativeSurface(pkg: PackageArtifact): NativeSurface | undefined {
  const nodeFiles: string[] = [];
  for (const path of pkg.files.keys()) {
    if (path.toLowerCase().endsWith('.node')) nodeFiles.push(path);
  }
  const fetcherDeps = fetcherDepsOf(pkg);
  let scriptFetcher: string | undefined;
  for (const [name, body] of Object.entries(manifestScripts(pkg))) {
    if (FETCHER_TOKENS.some((token) => body.includes(token))) {
      scriptFetcher = `${name}: ${body}`;
      break;
    }
  }
  if (nodeFiles.length === 0 && fetcherDeps.length === 0 && scriptFetcher === undefined) {
    return undefined;
  }
  return { nodeFiles, fetcherDeps, scriptFetcher };
}

export const nativeBinaryAnalyzer: Analyzer = {
  id: 'native-binary',
  scope: 'package',
  needsPrevious: false,
  needsProject: false,
  async analyze(ctx) {
    const signals: Signal[] = [];
    const current = nativeSurface(ctx.pkg);
    if (current === undefined) return signals;

    const reasons: string[] = [];
    if (current.nodeFiles.length > 0) {
      reasons.push(
        `${current.nodeFiles.length} prebuilt .node binar${current.nodeFiles.length === 1 ? 'y' : 'ies'} shipped (${current.nodeFiles[0]})`,
      );
    }
    if (current.fetcherDeps.length > 0) {
      reasons.push(`prebuilt-binary fetcher in deps: ${current.fetcherDeps.join(', ')}`);
    }
    if (current.scriptFetcher !== undefined) {
      reasons.push('lifecycle script invokes a prebuilt-binary fetcher');
    }

    signals.push({
      analyzer: 'native-binary',
      code: 'LW009-NATIVE-BINARY',
      kind: 'absolute',
      package: pkgRef(ctx.pkg),
      evidence: {
        file: current.nodeFiles[0] ?? 'package.json',
        excerpt: current.scriptFetcher === undefined ? undefined : excerpt(current.scriptFetcher),
        detail: `prebuilt native binary surface: ${reasons.join('; ')}`,
      },
      metrics: {
        nodeFileCount: current.nodeFiles.length,
        fetcherDepCount: current.fetcherDeps.length,
        scriptFetcher: current.scriptFetcher === undefined ? 0 : 1,
      },
    });

    if (ctx.previous !== undefined && nativeSurface(ctx.previous) === undefined) {
      signals.push({
        analyzer: 'native-binary',
        code: 'LW009D-NATIVE-BINARY-INTRODUCED',
        kind: 'delta',
        package: pkgRef(ctx.pkg),
        evidence: {
          file: current.nodeFiles[0] ?? 'package.json',
          detail: `prebuilt native binary surface is NEW in ${ctx.pkg.version} (none in ${ctx.previous.version}): ${reasons.join('; ')}`,
        },
      });
    }
    return signals;
  },
};
