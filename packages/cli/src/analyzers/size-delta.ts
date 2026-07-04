import { pkgRef, resolveMainEntry } from './shared.ts';
import type { Analyzer, Signal } from './types.ts';

/**
 * LW005 — main-entry-file size anomaly. DELTA ONLY: there is no absolute
 * notion of "too big". A >5x jump between adjacent versions is the classic
 * payload-injection tell (node-ipc, autotel family).
 */

const RATIO_CUTOFF = 5;

export const sizeDeltaAnalyzer: Analyzer = {
  id: 'size-delta',
  scope: 'package',
  needsPrevious: true,
  needsProject: false,
  async analyze(ctx) {
    const signals: Signal[] = [];
    if (ctx.previous === undefined) return signals;

    const current = resolveMainEntry(ctx.pkg);
    const previous = resolveMainEntry(ctx.previous);
    if (current === undefined || previous === undefined || previous.size === 0) return signals;

    const ratio = current.size / previous.size;
    if (ratio > RATIO_CUTOFF) {
      signals.push({
        analyzer: 'size-delta',
        code: 'LW005D-SIZE-INTRODUCED',
        kind: 'delta',
        package: pkgRef(ctx.pkg),
        evidence: {
          file: current.path,
          detail: `main entry file grew ${ratio.toFixed(1)}x between ${ctx.previous.version} (${previous.size} B) and ${ctx.pkg.version} (${current.size} B)`,
        },
        metrics: {
          sizeRatio: Number(ratio.toFixed(3)),
          prevBytes: previous.size,
          curBytes: current.size,
        },
      });
    }
    return signals;
  },
};
