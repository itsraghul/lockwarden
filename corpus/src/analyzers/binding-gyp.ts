import {
  type Analyzer,
  type PackageArtifact,
  type Signal,
  excerpt,
} from '../../../packages/cli/src/analyzers/types.ts';
import { manifestScripts, pkgRef } from './shared.ts';

/**
 * LW002 — native build hook surface: binding.gyp file, `gypfile: true`,
 * or any lifecycle script invoking node-gyp. Legitimate native packages
 * carry this forever — the delta signal (newly appeared) is what matters.
 */

interface GypSurface {
  file?: string;
  gypfile: boolean;
  scriptHook?: string;
}

function gypSurface(pkg: PackageArtifact): GypSurface | undefined {
  let file: string | undefined;
  for (const path of pkg.files.keys()) {
    if (path === 'binding.gyp' || path.endsWith('/binding.gyp')) {
      file = path;
      break;
    }
  }
  const gypfile = pkg.manifest.gypfile === true;
  let scriptHook: string | undefined;
  for (const [name, body] of Object.entries(manifestScripts(pkg))) {
    if (body.includes('node-gyp')) {
      scriptHook = `${name}: ${body}`;
      break;
    }
  }
  if (file === undefined && !gypfile && scriptHook === undefined) return undefined;
  return { file, gypfile, scriptHook };
}

export const bindingGypAnalyzer: Analyzer = {
  id: 'binding-gyp',
  scope: 'package',
  needsPrevious: false,
  needsProject: false,
  async analyze(ctx) {
    const signals: Signal[] = [];
    const current = gypSurface(ctx.pkg);
    if (current === undefined) return signals;

    const reasons: string[] = [];
    if (current.file !== undefined) reasons.push(`binding.gyp present (${current.file})`);
    if (current.gypfile) reasons.push('manifest declares gypfile: true');
    if (current.scriptHook !== undefined) reasons.push('lifecycle script invokes node-gyp');

    signals.push({
      analyzer: 'binding-gyp',
      code: 'LW002-BINDING-GYP',
      kind: 'absolute',
      package: pkgRef(ctx.pkg),
      evidence: {
        file: current.file ?? 'package.json',
        excerpt: current.scriptHook === undefined ? undefined : excerpt(current.scriptHook),
        detail: `native build hook: ${reasons.join('; ')}`,
      },
      metrics: {
        hasGypFile: current.file === undefined ? 0 : 1,
        gypfileFlag: current.gypfile ? 1 : 0,
        scriptMentionsNodeGyp: current.scriptHook === undefined ? 0 : 1,
      },
    });

    if (ctx.previous !== undefined && gypSurface(ctx.previous) === undefined) {
      signals.push({
        analyzer: 'binding-gyp',
        code: 'LW002D-BINDING-GYP-INTRODUCED',
        kind: 'delta',
        package: pkgRef(ctx.pkg),
        evidence: {
          file: current.file ?? 'package.json',
          detail: `native build hook is NEW in ${ctx.pkg.version} (no gyp surface in ${ctx.previous.version}): ${reasons.join('; ')}`,
        },
      });
    }
    return signals;
  },
};
