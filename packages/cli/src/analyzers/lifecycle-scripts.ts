import { LIFECYCLE_HOOKS, manifestScripts, pkgRef } from './shared.ts';
import { type Analyzer, type Signal, excerpt } from './types.ts';

/**
 * LW001 — npm lifecycle install scripts (preinstall/install/postinstall/prepare).
 * Absolute: the script exists (npm runs it without asking) — emitted for all
 * four hooks.
 * Delta: emitted ONLY for preinstall/install/postinstall — the hooks that
 * execute on a CONSUMER's `npm install` of this dependency. `prepare` does
 * not run when a published registry dep is installed (only in the package's
 * own dev install / git-dep installs), so a `prepare` body change is not a
 * consumer-install execution event. CORPUS TUNING (calibration v1): including
 * `prepare` in the delta signal produced a benign false-positive Critical
 * (uuid 14.0.0→14.0.1 migrated husky→lefthook). Excluding it removes the FP
 * with zero loss of consumer-install attack coverage.
 *
 * CORPUS TUNING (top-500 run, 2026-07-06): a CHANGED script body where both
 * the old and new bodies are pure, well-known native-toolchain invocations is
 * a toolchain migration, not a payload change — bcrypt 5.1.1→6.0.0 swapped
 * `node-pre-gyp install --fallback-to-build` for `node-gyp-build` and was the
 * single benign delta Critical in 496 real bumps. The exemption applies ONLY
 * to the changed-body delta (a freshly INTRODUCED hook always signals), and
 * any non-toolchain segment (e.g. `&& node payload.js` — the node-ipc shape,
 * covered by the tamper-install-script corpus fixtures) still fires.
 */

/** Hooks that auto-execute on a consumer's install of this dependency. */
const INSTALL_TRIGGER_HOOKS = new Set(['preinstall', 'install', 'postinstall']);

/**
 * One well-known native build/fetch tool with plain flag/word arguments.
 * No paths, URLs, quotes, or shell metacharacters — `/` is deliberately
 * excluded so `--directory=../x` or piped fetches never match.
 */
const TOOLCHAIN_SEGMENT_RE =
  /^(?:node-gyp-build(?:-optional|-test)?|node-pre-gyp|prebuild-install|prebuildify|node-gyp|cmake-js)(?:\s+(?:--?)?[A-Za-z0-9._=-]+)*$/;

/** True when the whole body is toolchain invocations joined by && / ||. */
function isToolchainInvocation(body: string): boolean {
  const segments = body.split(/\s*(?:&&|\|\|)\s*/);
  return segments.every((segment) => TOOLCHAIN_SEGMENT_RE.test(segment.trim()));
}
export const lifecycleScriptsAnalyzer: Analyzer = {
  id: 'lifecycle-scripts',
  scope: 'package',
  needsPrevious: false,
  needsProject: false,
  async analyze(ctx) {
    const signals: Signal[] = [];
    const current = manifestScripts(ctx.pkg);
    const previous = ctx.previous === undefined ? undefined : manifestScripts(ctx.previous);

    for (const hook of LIFECYCLE_HOOKS) {
      const body = current[hook];
      if (body === undefined || body.trim() === '') continue;

      signals.push({
        analyzer: 'lifecycle-scripts',
        code: 'LW001-LIFECYCLE',
        kind: 'absolute',
        package: pkgRef(ctx.pkg),
        evidence: {
          file: 'package.json',
          excerpt: excerpt(`"${hook}": "${body}"`),
          detail: `lifecycle script "${hook}" runs automatically on install`,
        },
        metrics: { scriptLength: body.length },
      });

      if (previous !== undefined && INSTALL_TRIGGER_HOOKS.has(hook)) {
        const prevBody = previous[hook];
        if (prevBody === undefined) {
          signals.push({
            analyzer: 'lifecycle-scripts',
            code: 'LW001D-LIFECYCLE-INTRODUCED',
            kind: 'delta',
            package: pkgRef(ctx.pkg),
            evidence: {
              file: 'package.json',
              excerpt: excerpt(`"${hook}": "${body}"`),
              detail: `lifecycle script "${hook}" is NEW in ${ctx.pkg.version} (absent in ${ctx.previous?.version})`,
            },
            metrics: { introduced: 1, changed: 0 },
          });
        } else if (
          prevBody !== body &&
          !(isToolchainInvocation(prevBody) && isToolchainInvocation(body))
        ) {
          signals.push({
            analyzer: 'lifecycle-scripts',
            code: 'LW001D-LIFECYCLE-INTRODUCED',
            kind: 'delta',
            package: pkgRef(ctx.pkg),
            evidence: {
              file: 'package.json',
              excerpt: excerpt(`"${hook}": "${body}"`),
              detail: `lifecycle script "${hook}" body CHANGED between ${ctx.previous?.version} and ${ctx.pkg.version}`,
            },
            metrics: { introduced: 0, changed: 1 },
          });
        }
      }
    }
    return signals;
  },
};
