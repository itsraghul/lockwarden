import {
  type IncidentBundle,
  loadIncidents,
  osvSnapshotInfo,
  vendoredIncidentIds,
} from '../data/index.js';
import { ExecError, ExitCode } from '../exit.js';
import type { GlobalOptions } from '../index.js';
import { bold, configureOutput, dim, printJson } from '../lib/output.js';

/** One row of the listing — counts, not payloads (the bundle data stays internal). */
export interface IncidentListing {
  id: string;
  name: string;
  date: string;
  summary: string;
  packages: number;
  fileIocs: number;
  references?: string[];
  /** Present (true) only for LOCKWARDEN_INCIDENT_DIR overlays not in this build. */
  local?: true;
}

export interface IncidentsReport {
  command: 'incidents';
  incidents: IncidentListing[];
  osv: { generatedAt: string; source: string; windowMonths: number | null; entries: number };
  exitCode: 0;
}

/**
 * `incidents` lists what `check --incident <id>` accepts: every vendored
 * incident bundle in this build, plus any LOCKWARDEN_INCIDENT_DIR overlays.
 * Purely informational — always exit 0 (2 only on execution errors, e.g. a
 * malformed overlay bundle). Reads zero network, zero lockfiles.
 */
export async function runIncidents(globals: GlobalOptions): Promise<number> {
  configureOutput({ json: globals.json, ci: globals.ci });

  let bundles: Map<string, IncidentBundle>;
  try {
    bundles = loadIncidents();
  } catch (err) {
    throw new ExecError(
      `cannot read LOCKWARDEN_INCIDENT_DIR overlays: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const vendored = vendoredIncidentIds();

  const incidents: IncidentListing[] = [...bundles.values()]
    .map((bundle) => ({
      id: bundle.id,
      name: bundle.name,
      date: bundle.date,
      summary: bundle.summary,
      packages: bundle.packages.length,
      fileIocs: bundle.fileIocs?.length ?? 0,
      ...(bundle.references !== undefined ? { references: bundle.references } : {}),
      ...(vendored.has(bundle.id) ? {} : { local: true as const }),
    }))
    // Newest first; id breaks date ties deterministically.
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));

  const report: IncidentsReport = {
    command: 'incidents',
    incidents,
    osv: osvSnapshotInfo(),
    exitCode: ExitCode.Clean,
  };

  if (globals.json) {
    printJson(report);
    return ExitCode.Clean;
  }
  renderHuman(report, globals);
  return ExitCode.Clean;
}

function renderHuman(report: IncidentsReport, globals: GlobalOptions): void {
  const { incidents, osv } = report;
  const plural = incidents.length === 1 ? 'bundle' : 'bundles';
  const window = osv.windowMonths === null ? '' : `, ${osv.windowMonths}mo window`;
  console.log(
    `${bold(String(incidents.length))} incident ${plural} · OSV snapshot ${osv.generatedAt} (${osv.entries} entries${window})`,
  );
  if (globals.ci) return;

  for (const incident of incidents) {
    console.log();
    const local = incident.local === true ? ` ${dim('[local overlay]')}` : '';
    console.log(`  ${bold(incident.id)} — ${incident.name} (${incident.date})${local}`);
    const iocs = incident.fileIocs > 0 ? ` · ${incident.fileIocs} file IOC(s)` : '';
    console.log(dim(`      ${incident.packages} package(s)${iocs}`));
    console.log(dim(`      ${incident.summary}`));
    console.log(dim(`      npx lockwarden check --incident ${incident.id}`));
  }
}
