import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { relative } from 'node:path';
import { gzipSync } from 'node:zlib';
// Version is injected from package.json at build time by tsup (JSON inline).
import pkgJson from '../../package.json' with { type: 'json' };
import { ALL_ANALYZERS } from '../analyzers/index.js';
import type { AnalyzerContext, FileEntry, Signal } from '../analyzers/types.js';
import { advisoryFreshness } from '../data/index.js';
import { ExecError, ExitCode } from '../exit.js';
import type { GlobalOptions } from '../index.js';
import { advisoryAgeDays, advisoryNow, enforceMaxAdvisoryAge } from '../lib/advisory-age.js';
import {
  type ArchiveEntry,
  applyLayers,
  isDockerSaveLayout,
  layersOf,
} from '../lib/docker-save.js';
import { type EmbeddedPackage, findEmbeddedRoots } from '../lib/embedded.js';
import { setOffline } from '../lib/net.js';
import { bad, bold, configureOutput, dim, paint, printJson, warn } from '../lib/output.js';
import { readTarGz } from '../lib/tar.js';
import { readZip } from '../lib/zip.js';
import { buildRollup, scorePackage } from '../scoring/engine.js';
import { type Layer2Sources, layer2Findings, loadLayer2Sources } from '../scoring/layer2.js';
import { toSarif } from '../scoring/sarif.js';
import { exceedsThreshold, parseThreshold } from '../scoring/threshold.js';
import type {
  AuditReport,
  Finding,
  Layer2Finding,
  PackageReport,
  Rollup,
} from '../scoring/types.js';
import type { Grade, Severity } from '../scoring/weights.js';

export interface ScanOptions {
  image?: string;
  verbose?: boolean;
}

export type ArtifactKind = 'directory' | 'tgz' | 'tar' | 'zip' | 'docker-save';

/** A flagged embedded package, with the root it was found under. */
export interface ScanPackageReport extends PackageReport {
  /** artifact-relative posix path of the embedded package root ('' = artifact root) */
  root: string;
}

/** `scan` report: shaped like AuditReport, keyed by artifact instead of lockfile. */
export interface ScanReport {
  command: 'scan';
  artifact: { path: string; kind: ArtifactKind; roots: number };
  packages: ScanPackageReport[]; // only packages with ≥1 finding
  rollup: Rollup;
  warnings: string[];
  /** Vendored advisory-data freshness stamps — dates only, never ages. */
  advisories: { osvGeneratedAt: string; newestIncident: string };
}

const PACKAGE_ANALYZERS = ALL_ANALYZERS.filter((a) => a.scope === 'package');

export async function runScan(
  artifactPath: string | undefined,
  options: ScanOptions,
  globals: GlobalOptions,
): Promise<number> {
  configureOutput({ json: globals.json, ci: globals.ci });
  setOffline(globals.offline); // scan does no network — offline is always satisfiable
  // Parse the threshold before any work: a bad value is exit 2, immediately.
  const threshold = parseThreshold(globals.threshold);
  enforceMaxAdvisoryAge(globals.maxAdvisoryAge);

  if (options.image !== undefined && artifactPath !== undefined) {
    throw new ExecError(
      'pass an artifact path OR --image <docker-image>, not both',
      'scan audits one artifact per run',
    );
  }
  if (options.image === undefined && artifactPath === undefined) {
    throw new ExecError(
      'nothing to scan',
      'pass an artifact path (directory, .tgz, .zip, .tar, docker-save tar) or --image <docker-image>',
    );
  }

  const warnings: string[] = [];
  const { files, kind, displayPath } = await loadArtifact(artifactPath, options.image);

  const { packages: embedded, warnings: rootWarnings } = await findEmbeddedRoots(files);
  warnings.push(...rootWarnings);
  if (embedded.length === 0) {
    warnings.push('no package.json with a name+version found in the artifact — nothing to analyze');
  }

  const sources = loadLayer2Sources();
  const iocIndex = buildIocIndex(sources);

  const reports: ScanPackageReport[] = [];
  for (const pkg of embedded) {
    reports.push({ ...(await analyzeEmbedded(pkg, sources, iocIndex)), root: pkg.root });
  }

  const flagged = reports
    .filter((r) => r.findings.length > 0)
    .sort(
      (a, b) =>
        GRADE_RANK[b.grade] - GRADE_RANK[a.grade] ||
        a.key.localeCompare(b.key) ||
        a.root.localeCompare(b.root),
    );
  const rollup = buildRollup(reports, embedded.length);

  const freshness = advisoryFreshness();
  const advisories = {
    osvGeneratedAt: freshness.osvGeneratedAt,
    newestIncident: freshness.newestIncidentDate,
  };
  const report: ScanReport = {
    command: 'scan',
    artifact: { path: displayPath, kind, roots: embedded.length },
    packages: flagged,
    rollup,
    warnings,
    advisories,
  };

  // SARIF + threshold reuse the audit-shaped view: artifactLocation.uri is
  // the artifact path; the logical location is `<embedded-root>:<name>@<ver>`.
  const auditView: AuditReport = {
    command: 'audit',
    mode: 'absolute',
    lockfile: { path: displayPath, type: kind },
    packages: flagged.map((pkg) => ({
      ...pkg,
      key: pkg.root === '' ? pkg.key : `${pkg.root}:${pkg.key}`,
    })),
    rollup,
    warnings,
    advisories,
  };

  const exitCode = exceedsThreshold(auditView, threshold) ? ExitCode.Findings : ExitCode.Clean;

  if (globals.sarif) {
    process.stdout.write(
      `${JSON.stringify(
        toSarif(auditView, { verbose: options.verbose, toolVersion: pkgJson.version }),
        null,
        2,
      )}\n`,
    );
    return exitCode;
  }
  if (globals.json) {
    printJson(report);
    return exitCode;
  }
  renderHuman(report, globals);
  return exitCode;
}

/* ----------------------------- artifact input ---------------------------- */

interface LoadedArtifact {
  files: Map<string, FileEntry>;
  kind: ArtifactKind;
  displayPath: string;
}

function isGzip(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

function isTar(buf: Buffer): boolean {
  return buf.length > 262 && buf.toString('ascii', 257, 262) === 'ustar';
}

/** Decode a tar buffer whether gzipped or plain (readTarGz wants gzip). */
async function readTarAuto(buf: Buffer): Promise<ArchiveEntry[]> {
  return await readTarGz(isGzip(buf) ? buf : gzipSync(buf));
}

function toFileMap(entries: ArchiveEntry[]): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>();
  for (const entry of entries) {
    if (entry.path === '') continue;
    files.set(entry.path, {
      path: entry.path,
      size: entry.size,
      read: () => Promise.resolve(entry.data),
    });
  }
  return files;
}

/** Sniff by content, not extension: directory, gzip tar, zip, plain tar, docker-save. */
async function loadArtifact(
  artifactPath: string | undefined,
  image: string | undefined,
): Promise<LoadedArtifact> {
  if (image !== undefined) {
    const { dir, file } = await dockerSaveToTemp(image);
    try {
      const buf = await readFile(file);
      const entries = await wrapMalformed(`docker save ${image}`, () => readTarAuto(buf));
      return {
        files: toFileMap(await dockerLayersToFiles(entries, `docker save ${image}`)),
        kind: 'docker-save',
        displayPath: `docker:${image}`,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const target = artifactPath as string;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(target);
  } catch {
    throw new ExecError(`artifact not found: ${target}`);
  }

  if (info.isDirectory()) {
    return { files: await walkDirectory(target), kind: 'directory', displayPath: target };
  }

  const buf = await readFile(target);
  if (isZip(buf)) {
    const entries = await wrapMalformed(target, async () => readZip(buf));
    return { files: toFileMap(entries), kind: 'zip', displayPath: target };
  }
  if (isGzip(buf) || isTar(buf)) {
    const entries = await wrapMalformed(target, () => readTarAuto(buf));
    if (isDockerSaveLayout(entries)) {
      return {
        files: toFileMap(await dockerLayersToFiles(entries, target)),
        kind: 'docker-save',
        displayPath: target,
      };
    }
    return { files: toFileMap(entries), kind: isGzip(buf) ? 'tgz' : 'tar', displayPath: target };
  }
  throw new ExecError(
    `unrecognized artifact format: ${target}`,
    'supported: a directory, a .tgz/.tar.gz or .tar archive, a .zip archive, or a docker-save tar',
  );
}

/** Malformed archives are user-input errors: exit 2 with the parser's message. */
async function wrapMalformed<T>(what: string, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ExecError) throw err;
    throw new ExecError(
      `failed to read artifact ${what}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Decode + overlay docker-save layers into the image's final filesystem. */
async function dockerLayersToFiles(entries: ArchiveEntry[], what: string): Promise<ArchiveEntry[]> {
  return await wrapMalformed(what, async () => {
    const layers: ArchiveEntry[][] = [];
    for (const buffer of layersOf(entries)) {
      layers.push(await readTarAuto(buffer));
    }
    return [...applyLayers(layers).values()];
  });
}

/**
 * Walk a directory into the flat artifact file map. Unlike dirToArtifact,
 * node_modules is INCLUDED — vendored trees are exactly what scan audits.
 * Symlinks are never followed; .git is skipped.
 */
async function walkDirectory(dir: string): Promise<Map<string, FileEntry>> {
  const root = path.resolve(dir);
  const files = new Map<string, FileEntry>();

  async function walk(current: string, relPrefix: string): Promise<void> {
    const dirents = await readdir(current, { withFileTypes: true });
    for (const dirent of dirents) {
      const abs = path.join(current, dirent.name);
      const rel = relPrefix === '' ? dirent.name : `${relPrefix}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (dirent.name === '.git') continue;
        await walk(abs, rel);
      } else if (dirent.isFile()) {
        const info = await stat(abs);
        files.set(rel, { path: rel, size: info.size, read: () => readFile(abs) });
      }
      // symlinks and special files: skipped, never followed
    }
  }

  await walk(root, '');
  return files;
}

/* ------------------------------ docker save ------------------------------ */

/** Stream `docker save <image>` into a temp file (images do not fit in RAM). */
async function dockerSaveToTemp(image: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lockwarden-scan-'));
  const file = path.join(dir, 'image.tar');

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('docker', ['save', image], { stdio: ['ignore', 'pipe', 'pipe'] });
      const out = createWriteStream(file);
      let stderr = '';
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        out.destroy();
        reject(err);
      };

      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          fail(
            new ExecError(
              'docker binary not found — cannot run `docker save`',
              `install Docker, or export the image yourself: docker save ${image} -o image.tar && lockwarden scan image.tar`,
            ),
          );
        } else {
          fail(new ExecError(`docker save ${image} failed: ${err.message}`));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.stdout.pipe(out);
      out.on('error', (err) => fail(new ExecError(`writing ${file} failed: ${err.message}`)));
      child.on('close', (code) => {
        if (code !== 0) {
          fail(
            new ExecError(
              `docker save ${image} failed (exit ${code ?? 'signal'})`,
              stderr.trim() === '' ? undefined : stderr.trim().split('\n').slice(-3).join('\n'),
            ),
          );
          return;
        }
        out.on('finish', () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
        out.end();
      });
    });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }

  return { dir, file };
}

/* ------------------------------ analysis --------------------------------- */

interface IocRef {
  incidentId: string;
  summary: string;
}

/** sha256 (lowercase hex) → incidents listing that file IOC. */
function buildIocIndex(sources: Layer2Sources): Map<string, IocRef[]> {
  const index = new Map<string, IocRef[]>();
  for (const incident of sources.incidents) {
    for (const ioc of incident.fileIocs ?? []) {
      const hash = ioc.sha256.toLowerCase();
      const refs = index.get(hash);
      const ref = { incidentId: incident.id, summary: incident.summary };
      if (refs === undefined) index.set(hash, [ref]);
      else refs.push(ref);
    }
  }
  return index;
}

/** File-content IOC matches for one embedded package (sha256 of every file). */
async function fileIocFindings(
  pkg: EmbeddedPackage,
  iocIndex: Map<string, IocRef[]>,
): Promise<Layer2Finding[]> {
  if (iocIndex.size === 0) return [];
  const findings: Layer2Finding[] = [];
  const seen = new Set<string>();
  for (const [filePath, entry] of pkg.artifact.files) {
    const hash = createHash('sha256')
      .update(await entry.read())
      .digest('hex');
    for (const ref of iocIndex.get(hash) ?? []) {
      const dedupe = `${ref.incidentId}:${filePath}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      findings.push({
        layer: 2,
        severity: 'critical',
        code: `LW2-IOC-${ref.incidentId}-FILE`,
        package: { name: pkg.artifact.name, version: pkg.artifact.version },
        layer2: {
          source: 'incident',
          id: ref.incidentId,
          summary: `file content matches incident IOC sha256 (${filePath}): ${ref.summary}`,
        },
      });
    }
  }
  return findings;
}

/** Layer 1 absolute-mode analyzers + Layer 2 name/version + file IOC overlay. */
async function analyzeEmbedded(
  pkg: EmbeddedPackage,
  sources: Layer2Sources,
  iocIndex: Map<string, IocRef[]>,
): Promise<PackageReport> {
  const ctx: AnalyzerContext = { pkg: pkg.artifact };
  const signals: Signal[] = [];
  for (const analyzer of PACKAGE_ANALYZERS) {
    if (analyzer.needsPrevious) continue; // scan has no previous version to diff
    signals.push(...(await analyzer.analyze(ctx)));
  }
  const layer2: Finding[] = [
    ...layer2Findings({ name: pkg.artifact.name, version: pkg.artifact.version }, sources),
    ...(await fileIocFindings(pkg, iocIndex)),
  ];
  return scorePackage({ name: pkg.artifact.name, version: pkg.artifact.version }, signals, layer2);
}

/* ------------------------------- rendering ------------------------------- */

const GRADE_RANK: Record<Grade, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };

function paintGrade(grade: Grade, text: string): string {
  if (grade === 'A') return paint('green', text);
  if (grade === 'B' || grade === 'C') return warn(text);
  return bad(text);
}

function paintSeverity(severity: Severity): string {
  const label = `[${severity}]`;
  if (severity === 'critical' || severity === 'high') return bad(label);
  if (severity === 'med') return warn(label);
  return dim(label);
}

function findingLine(finding: Finding): string {
  if (finding.layer === 2) {
    return `${paintSeverity(finding.severity)} ${finding.code} — known-bad (${finding.layer2.source}: ${finding.layer2.id}) ${finding.layer2.summary}`;
  }
  const file = finding.signal.evidence.file;
  const where = file === undefined ? '' : ` ${dim(file)}`;
  return `${paintSeverity(finding.severity)} ${finding.signal.code}${where} — ${finding.signal.evidence.detail}`;
}

function countsLine(rollup: Rollup): string {
  const parts: string[] = [];
  for (const severity of ['critical', 'high', 'med', 'low'] as const) {
    const count = rollup.counts[severity];
    if (count > 0) parts.push(`${severity} ${count}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'no findings';
}

function renderHuman(report: ScanReport, globals: GlobalOptions): void {
  const { rollup } = report;
  const plural = rollup.packagesFlagged === 1 ? 'package' : 'packages';
  console.log(
    `${paintGrade(rollup.grade, bold(`grade ${rollup.grade}`))} — ${rollup.packagesFlagged} ${plural} flagged of ${rollup.packagesAnalyzed} analyzed`,
  );
  console.log(dim(countsLine(rollup)));
  if (globals.ci) return;

  const artifactRel = report.artifact.path.startsWith('docker:')
    ? report.artifact.path
    : relative(process.cwd(), report.artifact.path) || report.artifact.path;
  const roots = report.artifact.roots === 1 ? 'root' : 'roots';
  console.log(
    dim(
      `artifact: ${artifactRel} (${report.artifact.kind}) — ${report.artifact.roots} embedded package ${roots}`,
    ),
  );
  const advisoryAge = advisoryAgeDays(report.advisories.osvGeneratedAt, advisoryNow());
  console.log(
    dim(
      `advisories: OSV ${report.advisories.osvGeneratedAt} · newest incident ${report.advisories.newestIncident} (${advisoryAge} day${advisoryAge === 1 ? '' : 's'} old)`,
    ),
  );
  for (const warning of report.warnings) console.log(dim(`warning: ${warning}`));

  for (const pkg of report.packages) {
    console.log();
    const where = pkg.root === '' ? dim(' (artifact root)') : ` ${dim(`(${pkg.root})`)}`;
    console.log(`  ${bold(pkg.key)}${where} — ${paintGrade(pkg.grade, `grade ${pkg.grade}`)}`);
    for (const finding of pkg.findings) {
      console.log(`    ${findingLine(finding)}`);
    }
  }
}
