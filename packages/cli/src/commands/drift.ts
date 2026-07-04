import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ExecError, ExitCode } from '../exit.js';
import type { GlobalOptions } from '../index.js';
import { type DriftFinding, computeDriftFindings } from '../lib/drift-rules.js';
import { repoRoot, showFileAt } from '../lib/git.js';
import { setOffline } from '../lib/net.js';
import { bad, bold, configureOutput, dim, ok, printJson, warn } from '../lib/output.js';
import { loadGraph, parseLockfileContent } from '../lockfile/detect.js';
import { parseThreshold } from '../scoring/threshold.js';
import { SEV_RANK, type Severity } from '../scoring/weights.js';

export interface DriftOptions {
  base?: string;
}

const PROVENANCE_NOTE =
  'provenance is informational only — valid provenance has shipped from compromised pipelines';

export async function runDrift(options: DriftOptions, globals: GlobalOptions): Promise<number> {
  configureOutput({ json: globals.json, ci: globals.ci });
  setOffline(globals.offline);
  // Parse the threshold before any work: a bad value is exit 2, immediately.
  const threshold = parseThreshold(globals.threshold);
  const base = options.base ?? 'main';

  const dirs = globals.dir.length > 0 ? globals.dir : [process.cwd()];
  const dir = dirs[0] ?? process.cwd();
  const warnings: string[] = [];
  if (dirs.length > 1) {
    warnings.push(
      `drift analyzes one project per run; using ${dir} (${dirs.length - 1} extra --dir ignored)`,
    );
  }

  const graph = loadGraph(dir);
  warnings.push(...graph.warnings);

  const root = await repoRoot(dir);
  const lockRel = relative(root, graph.lockfilePath);
  const baseContent = await showFileAt(dir, base, lockRel);
  if (baseContent === null) {
    throw new ExecError(
      `lockfile ${lockRel} not found at ref '${base}'`,
      'drift compares the working lockfile against a committed one; check the ref.',
    );
  }
  const baseGraph = parseLockfileContent(baseContent, graph.lockfileType, {
    lockfilePath: graph.lockfilePath,
  });

  const currentManifest = readManifest(join(dir, 'package.json'), warnings);
  const baseManifest = await readBaseManifest(dir, base, relative(root, join(dir, 'package.json')));

  const findings = computeDriftFindings({
    base: baseGraph,
    current: graph,
    baseManifest,
    currentManifest,
  });

  const floor = SEV_RANK[threshold];
  const exitCode = findings.some((f) => SEV_RANK[f.severity] >= floor)
    ? ExitCode.Findings
    : ExitCode.Clean;

  if (globals.json) {
    printJson({
      command: 'drift',
      base,
      lockfile: { path: graph.lockfilePath, type: graph.lockfileType },
      findings,
      warnings,
      exitCode,
    });
    return exitCode;
  }

  renderHuman(findings, { base, lockRel, warnings, ci: globals.ci });
  return exitCode;
}

/* -------------------------------- inputs -------------------------------- */

function readManifest(path: string, warnings: string[]): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    warnings.push(`cannot parse ${path}; direct-dependency drift classification may be incomplete`);
    return undefined;
  }
}

async function readBaseManifest(
  dir: string,
  ref: string,
  relPath: string,
): Promise<Record<string, unknown> | undefined> {
  const content = await showFileAt(dir, ref, relPath);
  if (content === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------- rendering ------------------------------- */

function paintSeverity(severity: Severity): string {
  const label = `[${severity}]`;
  if (severity === 'critical' || severity === 'high') return bad(label);
  if (severity === 'med') return warn(label);
  return dim(label);
}

function countsLine(findings: DriftFinding[]): string {
  const counts = new Map<Severity, number>();
  for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  const parts: string[] = [];
  for (const severity of ['critical', 'high', 'med', 'low'] as const) {
    const count = counts.get(severity) ?? 0;
    if (count > 0) parts.push(`${severity} ${count}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'no findings';
}

function renderHuman(
  findings: DriftFinding[],
  ctx: { base: string; lockRel: string; warnings: string[]; ci: boolean },
): void {
  console.log(`${bold('drift')} vs '${ctx.base}' — ${countsLine(findings)}`);
  if (ctx.ci) return;

  console.log(dim(`lockfile: ${ctx.lockRel}`));
  for (const warning of ctx.warnings) console.log(dim(`warning: ${warning}`));

  if (findings.length === 0) {
    console.log(`  ${ok('clean')}  no lockfile drift vs '${ctx.base}'`);
  } else {
    // computeDriftFindings sorts worst-first, so this prints grouped by severity.
    let currentSeverity: Severity | undefined;
    for (const finding of findings) {
      if (finding.severity !== currentSeverity) {
        currentSeverity = finding.severity;
        console.log();
      }
      console.log(
        `  ${paintSeverity(finding.severity)} ${finding.kind}  ${bold(finding.package ?? '')}`,
      );
      console.log(`       ${finding.detail}`);
      if (finding.evidence !== undefined) {
        for (const [k, v] of Object.entries(finding.evidence)) {
          console.log(dim(`       ${k}: ${v}`));
        }
      }
    }
  }

  console.log();
  console.log(dim(`note: ${PROVENANCE_NOTE}`));
}
