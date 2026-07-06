import { relative } from 'node:path';
import { type IncidentBundle, loadIncidents } from '../data/index.js';
import { ExecError, ExitCode } from '../exit.js';
import type { GlobalOptions } from '../index.js';
import { enforceMaxAdvisoryAge } from '../lib/advisory-age.js';
import { lockfileHistory, repoRoot, showFileAt } from '../lib/git.js';
import { setOffline } from '../lib/net.js';
import { bad, bold, configureOutput, dim, ok, printJson } from '../lib/output.js';
import { detectLockfile, loadGraph, parseLockfileContent } from '../lockfile/detect.js';
import { enumeratePaths, matchPackages } from '../lockfile/paths.js';
import { type DependencyPath, ROOT, type ResolutionGraph } from '../lockfile/types.js';

export interface CheckOptions {
  incident?: string;
  history?: boolean;
}

interface Hit {
  name: string;
  version: string;
  devOnly: boolean;
  paths: DependencyPath[];
  truncated: boolean;
}

interface QueryResult {
  query: string;
  hits: Hit[];
}

interface DirResult {
  dir: string;
  lockfile: { path: string; type: string };
  results: QueryResult[];
  warnings: string[];
}

interface HistoryWindow {
  version: string;
  firstSeen: { sha: string; date: string };
  lastSeen: { sha: string; date: string };
  stillPresent: boolean;
}

export async function runCheck(
  queries: string[],
  options: CheckOptions,
  globals: GlobalOptions,
): Promise<number> {
  configureOutput({ json: globals.json, ci: globals.ci });
  setOffline(globals.offline);

  if (options.incident && queries.length > 0) {
    throw new ExecError('--incident cannot be combined with package queries');
  }
  if (options.history && options.incident) {
    throw new ExecError('--history checks a single package, not an incident bundle');
  }
  if (options.history && queries.length !== 1) {
    throw new ExecError('--history requires exactly one package query');
  }
  if (!options.incident && queries.length === 0) {
    throw new ExecError(
      'nothing to check',
      'pass one or more <pkg>@<version> queries, or --incident <id>',
    );
  }

  const dirs = globals.dir.length > 0 ? globals.dir : [process.cwd()];

  let incident: IncidentBundle | undefined;
  let effectiveQueries = queries;
  if (options.incident) {
    // Advisory-age enforcement applies ONLY here: plain check/--history read
    // the lockfile and git, never advisory data — the incident-day triage
    // one-liner must not fail on staleness.
    enforceMaxAdvisoryAge(globals.maxAdvisoryAge);
    incident = loadIncidents().get(options.incident);
    if (!incident) {
      const known = [...loadIncidents().keys()].sort().join(', ');
      throw new ExecError(`unknown incident id "${options.incident}"`, `known incidents: ${known}`);
    }
    effectiveQueries = incidentQueries(incident);
  }

  if (options.history) {
    const query = effectiveQueries[0];
    if (query === undefined) throw new ExecError('--history requires exactly one package query');
    return await runHistory(query, dirs, globals);
  }

  const dirResults: DirResult[] = [];
  for (const dir of dirs) {
    const graph = await loadGraph(dir);
    const results = effectiveQueries.map((query) => ({
      query,
      hits: findHits(graph, query),
    }));
    dirResults.push({
      dir,
      lockfile: { path: graph.lockfilePath, type: graph.lockfileType },
      results,
      warnings: graph.warnings,
    });
  }

  const anyHit = dirResults.some((d) => d.results.some((r) => r.hits.length > 0));
  const exitCode = anyHit ? ExitCode.Findings : ExitCode.Clean;

  if (globals.json) {
    printJson({
      command: 'check',
      incident: incident
        ? { id: incident.id, name: incident.name, date: incident.date }
        : undefined,
      dirs: dirResults.map((d) => ({
        dir: d.dir,
        lockfile: d.lockfile,
        warnings: d.warnings,
        queries: d.results.map((r) => ({
          query: r.query,
          hit: r.hits.length > 0,
          matches: r.hits.map((h) => ({
            name: h.name,
            version: h.version,
            devOnly: h.devOnly,
            truncated: h.truncated,
            paths: h.paths.map(renderPathSegments),
          })),
        })),
      })),
      hit: anyHit,
      exitCode,
    });
    return exitCode;
  }

  renderHuman(dirResults, incident, globals);
  return exitCode;
}

function incidentQueries(incident: IncidentBundle): string[] {
  const queries: string[] = [];
  for (const pkg of incident.packages) {
    for (const version of pkg.versions ?? []) queries.push(`${pkg.name}@${version}`);
    for (const range of pkg.ranges ?? []) queries.push(`${pkg.name}@${range}`);
  }
  return queries;
}

function findHits(graph: ResolutionGraph, query: string): Hit[] {
  return matchPackages(graph, query).map((key) => {
    const pkg = graph.packages.get(key);
    const { paths, truncated } = enumeratePaths(graph, key, { maxPaths: 500 });
    return {
      name: pkg?.name ?? key,
      version: pkg?.version ?? '',
      devOnly: pkg?.dev ?? false,
      paths,
      truncated,
    };
  });
}

function renderPathSegments(path: DependencyPath): string[] {
  return path.map((seg) => (seg.key === ROOT ? '<root>' : seg.key));
}

function renderHuman(
  dirResults: DirResult[],
  incident: IncidentBundle | undefined,
  globals: GlobalOptions,
): void {
  if (incident) {
    console.log(
      `${bold('incident')}  ${incident.name} ${dim(`(${incident.id}, ${incident.date})`)}`,
    );
    console.log(dim(incident.summary));
    console.log();
  }
  for (const d of dirResults) {
    const lockRel = relative(process.cwd(), d.lockfile.path) || d.lockfile.path;
    console.log(dim(`lockfile: ${lockRel} (${d.lockfile.type})`));
    for (const warning of d.warnings) console.log(`  ${dim(`warning: ${warning}`)}`);
    for (const r of d.results) {
      if (r.hits.length === 0) {
        if (!globals.ci) console.log(`  ${ok('clean')}  ${r.query} — not in the resolved tree`);
        continue;
      }
      for (const hit of r.hits) {
        const devTag = hit.devOnly ? dim(' [dev-only]') : '';
        console.log(`  ${bad('HIT')}  ${bold(`${hit.name}@${hit.version}`)}${devTag}`);
        for (const path of hit.paths) {
          console.log(`       ${renderTrace(path)}`);
        }
        if (hit.truncated) {
          console.log(dim('       …more paths omitted (cap 500)'));
        }
      }
    }
    console.log();
  }
}

function renderTrace(path: DependencyPath): string {
  return path
    .map((seg, i) => {
      const label = seg.key === ROOT ? 'project' : seg.key;
      return i === 0 ? label : ` → ${label}`;
    })
    .join('');
}

async function runHistory(query: string, dirs: string[], globals: GlobalOptions): Promise<number> {
  const dir = dirs[0] ?? process.cwd();
  const detected = detectLockfile(dir);
  if (!detected) {
    throw new ExecError(`no lockfile found in ${dir}`);
  }
  const root = await repoRoot(dir);
  const rel = relative(root, detected.path);
  const commits = await lockfileHistory(dir, rel);
  if (commits.length === 0) {
    throw new ExecError(
      `the lockfile ${rel} has no git history`,
      '--history walks git log of the lockfile; commit it first',
    );
  }

  // Walk oldest → newest so windows read chronologically.
  const ordered = [...commits].reverse();
  const openWindows = new Map<string, HistoryWindow>();
  const windows: HistoryWindow[] = [];

  for (const commit of ordered) {
    const content = await showFileAt(dir, commit.sha, rel);
    let presentVersions = new Set<string>();
    if (content !== null) {
      try {
        const graph = parseLockfileContent(content, detected.type, {
          lockfilePath: detected.path,
        });
        presentVersions = new Set(
          matchPackages(graph, query).map((key) => graph.packages.get(key)?.version ?? key),
        );
      } catch {
        // Unparseable historical lockfile (e.g. ancient format) — treat as no data.
      }
    }
    for (const version of presentVersions) {
      const open = openWindows.get(version);
      if (open) {
        open.lastSeen = { sha: commit.sha, date: commit.date };
      } else {
        openWindows.set(version, {
          version,
          firstSeen: { sha: commit.sha, date: commit.date },
          lastSeen: { sha: commit.sha, date: commit.date },
          stillPresent: false,
        });
      }
    }
    for (const [version, window] of openWindows) {
      if (!presentVersions.has(version)) {
        windows.push(window);
        openWindows.delete(version);
      }
    }
  }
  for (const window of openWindows.values()) {
    window.stillPresent = true;
    windows.push(window);
  }

  const exitCode = windows.length > 0 ? ExitCode.Findings : ExitCode.Clean;

  if (globals.json) {
    printJson({
      command: 'check',
      history: { query, lockfile: rel, commitsExamined: commits.length, windows },
      hit: windows.length > 0,
      exitCode,
    });
    return exitCode;
  }

  console.log(dim(`history of ${rel} — ${commits.length} commits examined`));
  if (windows.length === 0) {
    console.log(`  ${ok('clean')}  ${query} never appeared in the resolved tree`);
    return exitCode;
  }
  console.log(`  ${bad('EXPOSED')}  ${bold(query)}`);
  for (const w of windows) {
    const until = w.stillPresent
      ? bad('still present')
      : `until ${w.lastSeen.date} (${w.lastSeen.sha.slice(0, 8)})`;
    console.log(
      `       ${w.version}: from ${w.firstSeen.date} (${w.firstSeen.sha.slice(0, 8)}) ${until}`,
    );
  }
  return exitCode;
}
