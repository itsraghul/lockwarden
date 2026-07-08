import { loadIncidents, loadOsvSnapshot } from '../data/index.js';
import { ExecError, ExitCode } from '../exit.js';
import type { GlobalOptions } from '../index.js';
import { bold, configureOutput, dim, printJson } from '../lib/output.js';
import {
  LAYER1_EXPLANATIONS,
  LAYER2_EXPLANATIONS,
  type Layer1Explanation,
  type Layer2Explanation,
} from '../scoring/explanations.js';
import { GRADE_OF_SEVERITY, type Severity, WEIGHTS } from '../scoring/weights.js';

/** One explained entry in the stable --json shape. */
export interface ExplainEntry {
  id: string;
  name: string;
  layer: 1 | 2;
  analyzer?: string;
  codes: { absolute?: string; delta?: string; pattern?: string };
  /** Layer 1 only — read live from the corpus-locked weights table. */
  weights?: { absolute: Severity; delta: Severity };
  /** Layer 2 only — any hit is critical by construction. */
  alwaysCritical?: true;
  detects: string;
  whyItMatters: string;
  whatToDo: string;
  elevation?: string;
  /** Vendored advisory matched by a full dynamic Layer-2 code query. */
  matched?: { source: 'osv' | 'incident'; id: string; summary: string; packages?: string[] };
}

export interface ExplainReport {
  command: 'explain';
  query?: string;
  entries: ExplainEntry[];
  exitCode: 0;
}

function layer1Entry(explanation: Layer1Explanation): ExplainEntry {
  return {
    id: explanation.id,
    name: explanation.name,
    layer: 1,
    analyzer: explanation.analyzer,
    codes: explanation.codes,
    weights: WEIGHTS[explanation.analyzer],
    detects: explanation.detects,
    whyItMatters: explanation.whyItMatters,
    whatToDo: explanation.whatToDo,
    ...(explanation.elevation !== undefined ? { elevation: explanation.elevation } : {}),
  };
}

function layer2Entry(explanation: Layer2Explanation): ExplainEntry {
  return {
    id: explanation.id,
    name: explanation.name,
    layer: 2,
    codes: { pattern: explanation.codePattern },
    alwaysCritical: true,
    detects: explanation.detects,
    whyItMatters: explanation.whyItMatters,
    whatToDo: explanation.whatToDo,
  };
}

/** Look up the vendored advisory a full dynamic Layer-2 code points at. */
function matchAdvisory(prefix: string, rest: string): ExplainEntry['matched'] {
  if (rest === '') return undefined;
  if (prefix === 'LW2-OSV') {
    const hits = loadOsvSnapshot().filter((entry) => entry.id.toUpperCase() === rest);
    const first = hits[0];
    if (first === undefined) return undefined;
    return {
      source: 'osv',
      id: first.id,
      summary: first.summary,
      packages: hits.map((entry) => entry.package),
    };
  }
  const incidentId = rest.replace(/-FILE$/, '').toLowerCase();
  const bundle = loadIncidents().get(incidentId);
  if (bundle === undefined) return undefined;
  return {
    source: 'incident',
    id: bundle.id,
    summary: bundle.summary,
    packages: bundle.packages.map((pkg) => pkg.name),
  };
}

/** All tokens `explain <code>` accepts, for the unknown-code hint. */
function knownTokens(): string {
  const layer1 = LAYER1_EXPLANATIONS.map((explanation) => explanation.id);
  const layer2 = LAYER2_EXPLANATIONS.map((explanation) => explanation.id);
  return [...layer1, ...layer2].join(', ');
}

function resolve(query: string): ExplainEntry[] {
  const upper = query.toUpperCase();
  const lower = query.toLowerCase();

  // Layer-2 prefixes first — they also start with "LW" but carry dynamic ids.
  for (const explanation of LAYER2_EXPLANATIONS) {
    if (upper === explanation.id || upper.startsWith(`${explanation.id}-`)) {
      const entry = layer2Entry(explanation);
      const rest = upper.slice(explanation.id.length + 1);
      const matched = matchAdvisory(explanation.id, rest);
      return [matched !== undefined ? { ...entry, matched } : entry];
    }
  }

  for (const explanation of LAYER1_EXPLANATIONS) {
    const codeMatch =
      upper === explanation.id ||
      upper === explanation.codes.absolute ||
      upper === explanation.codes.delta ||
      upper === `${explanation.id}D` ||
      lower === explanation.analyzer;
    if (codeMatch) return [layer1Entry(explanation)];
  }

  throw new ExecError(
    `unknown finding code "${query}"`,
    `codes: ${knownTokens()} — full codes like LW001-LIFECYCLE and analyzer ids like lifecycle-scripts work too`,
  );
}

/**
 * `explain` — what a finding code means, why it is weighted the way it is,
 * and what to do about it. Vendored knowledge, zero network, always exit 0
 * (2 for an unknown code). Weights are read live from the locked table.
 */
export async function runExplain(
  query: string | undefined,
  globals: GlobalOptions,
): Promise<number> {
  configureOutput({ json: globals.json, ci: globals.ci });

  const entries =
    query === undefined
      ? [...LAYER1_EXPLANATIONS.map(layer1Entry), ...LAYER2_EXPLANATIONS.map(layer2Entry)]
      : resolve(query);

  const report: ExplainReport = {
    command: 'explain',
    ...(query !== undefined ? { query } : {}),
    entries,
    exitCode: ExitCode.Clean,
  };

  if (globals.json) {
    printJson(report);
    return ExitCode.Clean;
  }
  if (query === undefined) renderList(entries);
  else for (const entry of entries) renderEntry(entry, globals);
  return ExitCode.Clean;
}

function weightsLine(entry: ExplainEntry): string {
  if (entry.weights === undefined) return 'always critical (grade F) on any hit';
  const { absolute, delta } = entry.weights;
  const abs =
    absolute === 'none' ? 'absolute: —' : `absolute: ${absolute} (${GRADE_OF_SEVERITY[absolute]})`;
  const del = delta === 'none' ? 'delta: —' : `delta: ${delta} (${GRADE_OF_SEVERITY[delta]})`;
  return `${abs} · ${del}`;
}

function renderList(entries: ExplainEntry[]): void {
  console.log(bold('finding codes') + dim(' — lockwarden explain <code> for details'));
  console.log();
  for (const entry of entries) {
    console.log(`  ${bold(entry.id.padEnd(8))} ${entry.name}`);
    console.log(dim(`           ${weightsLine(entry)}`));
  }
  console.log();
  console.log(dim('weights are corpus-locked (top-500 run 2026-07-06); delta = newly appeared'));
}

function renderEntry(entry: ExplainEntry, globals: GlobalOptions): void {
  const analyzer = entry.analyzer === undefined ? '' : ` ${dim(`[${entry.analyzer}]`)}`;
  console.log(`${bold(entry.id)} — ${entry.name}${analyzer}`);
  console.log(dim(`  ${weightsLine(entry)}`));
  const codes = [entry.codes.absolute, entry.codes.delta, entry.codes.pattern].filter(
    (code): code is string => code !== undefined,
  );
  console.log(dim(`  codes: ${codes.join(' · ')}`));
  if (globals.ci) return;
  console.log();
  console.log(`  ${bold('detects:')} ${entry.detects}`);
  console.log(`  ${bold('why it matters:')} ${entry.whyItMatters}`);
  console.log(`  ${bold('what to do:')} ${entry.whatToDo}`);
  if (entry.elevation !== undefined) console.log(`  ${bold('elevation:')} ${entry.elevation}`);
  if (entry.matched !== undefined) {
    console.log();
    const packages =
      entry.matched.packages === undefined || entry.matched.packages.length === 0
        ? ''
        : ` — packages: ${entry.matched.packages.join(', ')}`;
    console.log(
      `  ${bold(`matched ${entry.matched.source} advisory:`)} ${entry.matched.id}${packages}`,
    );
    console.log(dim(`  ${entry.matched.summary}`));
  }
  console.log();
  console.log(dim('  docs: https://lockwarden.dev/scoring/'));
}
