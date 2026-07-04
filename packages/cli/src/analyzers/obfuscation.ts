import { isJsPath, manifestScripts, pkgRef, resolveMainEntry, textOf } from './shared.ts';
import type { Analyzer, FileEntry, PackageArtifact, Signal } from './types.ts';

/**
 * LW007 — obfuscation markers, scanned ONLY in install-path files (files a
 * package can execute without being imported): lifecycle script targets,
 * binding.gyp-referenced JS, the main entry file, and anything whose path
 * mentions install. Precision over recall — Layer-1 delta signals carry
 * recall (spec §Open items 2).
 *
 * Cutoffs below are PROVISIONAL until the corpus separation report; the
 * measured values land in corpus/report/weights.json.
 */

export const OBFUSCATION_CUTOFFS = {
  /** hex escapes + hex array members per KB required to flag */
  hexPerKb: 40,
  /** hex-density rule only applies above this file size */
  hexMinBytes: 2048,
  /** a single line longer than this ... */
  packedLineLength: 50_000,
  /** ... with less than this fraction of whitespace is "packed" */
  packedMaxWhitespace: 0.05,
};

const FILE_TOKEN_RE = /[\w@./-]+\.(?:cjs|mjs|js)\b/g;

function normalizeToken(token: string): string {
  let t = token;
  while (t.startsWith('./')) t = t.slice(2);
  return t;
}

/** Files reachable from install-time execution paths. */
async function installPathFiles(pkg: PackageArtifact): Promise<FileEntry[]> {
  const picked = new Map<string, FileEntry>();
  const add = (entry: FileEntry | undefined): void => {
    if (entry !== undefined && isJsPath(entry.path)) picked.set(entry.path, entry);
  };
  const addTokensFrom = (text: string): void => {
    for (const match of text.matchAll(FILE_TOKEN_RE)) {
      add(pkg.files.get(normalizeToken(match[0])));
    }
  };

  // 1. files referenced by lifecycle script bodies
  for (const body of Object.values(manifestScripts(pkg))) {
    addTokensFrom(body);
  }
  // 2. JS referenced from binding.gyp
  for (const [path, entry] of pkg.files) {
    if (path === 'binding.gyp' || path.endsWith('/binding.gyp')) {
      addTokensFrom(await textOf(entry));
    }
  }
  // 3. the main entry file
  add(resolveMainEntry(pkg));
  // 4. any file whose path mentions install
  for (const [path, entry] of pkg.files) {
    if (path.toLowerCase().includes('install')) add(entry);
  }
  return [...picked.values()];
}

interface Markers {
  hexPerKb: number;
  hexTriggered: boolean;
  evalChain: boolean;
  packedLine: boolean;
}

const EVAL_RE = /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(/;
const DECODE_RE =
  /\batob\s*\(|String\.fromCharCode|Buffer\.from\s*\([^\n)]{0,200}(?:'base64'|"base64")/;

export function measureMarkers(text: string, bytes: number): Markers {
  const hexEscapes = text.match(/\\x[0-9a-fA-F]{2}/g)?.length ?? 0;
  const hexMembers = text.match(/0x[0-9a-fA-F]+\s*,/g)?.length ?? 0;
  const hexPerKb = bytes > 0 ? (hexEscapes + hexMembers) / (bytes / 1024) : 0;
  const hexTriggered =
    hexPerKb > OBFUSCATION_CUTOFFS.hexPerKb && bytes > OBFUSCATION_CUTOFFS.hexMinBytes;

  const evalChain = EVAL_RE.test(text) && DECODE_RE.test(text);

  let packedLine = false;
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      const len = i - lineStart;
      if (len > OBFUSCATION_CUTOFFS.packedLineLength) {
        let ws = 0;
        for (let j = lineStart; j < i; j++) {
          const c = text.charCodeAt(j);
          if (c === 0x20 || c === 0x09) ws++;
        }
        if (ws / len < OBFUSCATION_CUTOFFS.packedMaxWhitespace) {
          packedLine = true;
          break;
        }
      }
      lineStart = i + 1;
    }
  }

  return { hexPerKb: Number(hexPerKb.toFixed(2)), hexTriggered, evalChain, packedLine };
}

function triggered(m: Markers): string[] {
  const list: string[] = [];
  if (m.hexTriggered) list.push(`hex-array density ${m.hexPerKb}/KB`);
  if (m.evalChain) list.push('eval/Function combined with base64/charCode decoding');
  if (m.packedLine) list.push('packed single line >50k chars with <5% whitespace');
  return list;
}

async function markersByFile(pkg: PackageArtifact): Promise<Map<string, Markers>> {
  const out = new Map<string, Markers>();
  for (const entry of await installPathFiles(pkg)) {
    out.set(entry.path, measureMarkers(await textOf(entry), entry.size));
  }
  return out;
}

export const obfuscationAnalyzer: Analyzer = {
  id: 'obfuscation',
  scope: 'package',
  needsPrevious: false,
  needsProject: false,
  async analyze(ctx) {
    const signals: Signal[] = [];
    const current = await markersByFile(ctx.pkg);
    let previous: Map<string, Markers> | undefined;

    for (const [path, markers] of current) {
      const reasons = triggered(markers);
      if (reasons.length === 0) continue;

      const metrics: Record<string, number> = {
        hexPerKb: markers.hexPerKb,
        evalChain: markers.evalChain ? 1 : 0,
        packedLine: markers.packedLine ? 1 : 0,
      };
      signals.push({
        analyzer: 'obfuscation',
        code: 'LW007-OBFUSCATION',
        kind: 'absolute',
        package: pkgRef(ctx.pkg),
        evidence: {
          file: path,
          detail: `obfuscation markers in install-path file: ${reasons.join('; ')}`,
        },
        metrics,
      });

      if (ctx.previous !== undefined) {
        previous ??= await markersByFile(ctx.previous);
        const prev = previous.get(path);
        const prevTriggered = prev !== undefined && triggered(prev).length > 0;
        if (!prevTriggered) {
          signals.push({
            analyzer: 'obfuscation',
            code: 'LW007D-OBFUSCATION-INTRODUCED',
            kind: 'delta',
            package: pkgRef(ctx.pkg),
            evidence: {
              file: path,
              detail: `obfuscation markers are NEW in ${ctx.pkg.version} (clean in ${ctx.previous.version}): ${reasons.join('; ')}`,
            },
            metrics,
          });
        }
      }
    }
    return signals;
  },
};
