/**
 * Baseline suppression: a checked-in `.lockwarden-baseline.json` of accepted
 * findings so CI fails only on NEW execution surface — the delta-over-absolute
 * rule applied to adoption. Matching is VERSION-INDEPENDENT (code + package
 * name): accepted absolute surface persists across benign version bumps, and
 * what changes between versions is caught by the delta analyzers and Layer 2.
 *
 * Never suppressible, by construction:
 *   - any Layer-2 (known-bad) finding
 *   - any critical-severity finding
 *   - delta findings on a grade-F package (else suppressing two Highs could
 *     dissolve a corpus-elevated compound Critical — the node-ipc shape)
 * A consequence: suppression never lowers an F.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { ExecError } from '../exit.ts';
import { codeOf } from './fingerprint.ts';
import type { Finding, PackageReport, SuppressedFinding } from './types.ts';
import { GRADE_OF_SEVERITY, SEV_RANK, type Severity } from './weights.ts';

export const BASELINE_FILENAME = '.lockwarden-baseline.json';

export interface BaselineEntry {
  /** Rule id, e.g. "LW001-LIFECYCLE". Match key together with `package`. */
  code: string;
  /** Package name (no version). Match key together with `code`. */
  package: string;
  /** Version observed when the entry was added — audit trail only. */
  version?: string;
  /** ISO date the entry was added — audit trail only. */
  addedAt?: string;
  /** Why this finding is accepted. Emitted as SARIF suppression justification. */
  reason?: string;
  /** ISO date; on/after it the entry stops suppressing (with a warning). */
  expires?: string;
}

export interface BaselineFile {
  version: 1;
  generatedAt?: string;
  tool?: string;
  entries: BaselineEntry[];
}

export interface BaselineApplication<T extends PackageReport = PackageReport> {
  reports: T[];
  suppressedCounts: Record<Severity, number>;
  matched: number;
  expired: number;
  warnings: string[];
}

const HINT = 'See https://lockwarden.dev/commands/audit/#baseline for the expected shape.';

function entryKey(code: string, name: string): string {
  return `${code}:${name}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(
  raw: Record<string, unknown>,
  field: string,
  where: string,
): string | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw new ExecError(`baseline ${where}: "${field}" must be a string`, HINT);
  return value;
}

function parseEntry(raw: unknown, index: number): BaselineEntry {
  const where = `entry ${index}`;
  if (!isRecord(raw)) throw new ExecError(`baseline ${where}: must be an object`, HINT);
  const code = raw.code;
  const pkg = raw.package;
  if (typeof code !== 'string' || code.length === 0) {
    throw new ExecError(`baseline ${where}: "code" must be a non-empty string`, HINT);
  }
  if (typeof pkg !== 'string' || pkg.length === 0) {
    throw new ExecError(`baseline ${where}: "package" must be a non-empty string`, HINT);
  }
  // Unknown fields are ignored (forward compatibility).
  return {
    code,
    package: pkg,
    version: optionalString(raw, 'version', where),
    addedAt: optionalString(raw, 'addedAt', where),
    reason: optionalString(raw, 'reason', where),
    expires: optionalString(raw, 'expires', where),
  };
}

/** Read and validate a baseline file. Returns null when the file is absent. */
export async function loadBaseline(path: string): Promise<BaselineFile | null> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ExecError(
      `cannot read baseline ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new ExecError(
      `baseline ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      HINT,
    );
  }
  if (!isRecord(parsed)) throw new ExecError(`baseline ${path}: must be a JSON object`, HINT);
  if (parsed.version !== 1) {
    throw new ExecError(
      `baseline ${path}: unsupported "version" (expected 1)`,
      'Regenerate it with `lockwarden audit --write-baseline`.',
    );
  }
  if (!Array.isArray(parsed.entries)) {
    throw new ExecError(`baseline ${path}: "entries" must be an array`, HINT);
  }
  return {
    version: 1,
    generatedAt: parsed.generatedAt as string | undefined,
    tool: parsed.tool as string | undefined,
    entries: parsed.entries.map((raw, index) => parseEntry(raw, index)),
  };
}

function isExpired(entry: BaselineEntry, now: Date): boolean {
  if (entry.expires === undefined) return false;
  const expires = Date.parse(entry.expires);
  return !Number.isNaN(expires) && now.getTime() >= expires;
}

/**
 * A finding that must never be suppressed: Layer 2, critical severity, or a
 * delta finding on a grade-F package (protects corpus-elevated compounds).
 */
function isLocked(finding: Finding, pkg: PackageReport): boolean {
  if (finding.layer === 2) return true;
  if (finding.severity === 'critical') return true;
  return pkg.grade === 'F' && finding.signal.kind === 'delta';
}

/** Re-derive a grade from the surviving active findings. F never improves. */
function regrade(pkg: PackageReport, active: Finding[]): PackageReport['grade'] {
  if (pkg.grade === 'F') return 'F';
  let worst: Severity = 'none';
  for (const finding of active) {
    if (SEV_RANK[finding.severity] > SEV_RANK[worst]) worst = finding.severity;
  }
  return GRADE_OF_SEVERITY[worst];
}

/**
 * Split each package's findings into active vs suppressed per the baseline.
 * Pure: returns rebuilt reports, leaves the inputs untouched. Callers compute
 * exit codes and rollups from the ACTIVE findings only.
 */
export function applyBaseline<T extends PackageReport>(
  reports: T[],
  baseline: BaselineFile,
  now: Date,
): BaselineApplication<T> {
  const live = new Map<string, BaselineEntry>();
  const warnings: string[] = [];
  let expired = 0;
  for (const entry of baseline.entries) {
    if (isExpired(entry, now)) {
      expired += 1;
      warnings.push(
        `baseline entry ${entry.code} (${entry.package}) expired ${entry.expires} — no longer suppressing`,
      );
      continue;
    }
    live.set(entryKey(entry.code, entry.package), entry);
  }

  const suppressedCounts: Record<Severity, number> = {
    none: 0,
    low: 0,
    med: 0,
    high: 0,
    critical: 0,
  };
  let matched = 0;
  const lockedWarned = new Set<string>();

  const next = reports.map((pkg) => {
    const active: Finding[] = [];
    const suppressed: SuppressedFinding[] = [];
    for (const finding of pkg.findings) {
      const key = entryKey(codeOf(finding), pkg.name);
      const entry = live.get(key);
      if (entry === undefined) {
        active.push(finding);
        continue;
      }
      if (isLocked(finding, pkg)) {
        if (!lockedWarned.has(key)) {
          lockedWarned.add(key);
          warnings.push(
            `baseline entry ${entry.code} (${entry.package}) matches a non-suppressible finding — ignored`,
          );
        }
        active.push(finding);
        continue;
      }
      matched += 1;
      suppressedCounts[finding.severity] += 1;
      suppressed.push({
        ...finding,
        suppression: { reason: entry.reason, addedAt: entry.addedAt, expires: entry.expires },
      });
    }
    if (suppressed.length === 0) return pkg;
    return { ...pkg, grade: regrade(pkg, active), findings: active, suppressed };
  });

  return { reports: next, suppressedCounts, matched, expired, warnings };
}

export interface BuiltBaseline {
  file: BaselineFile;
  /** "code (name@version)" of findings skipped because they are locked. */
  skipped: string[];
  /** Entries from the previous baseline no longer observed (pruned). */
  pruned: number;
}

/**
 * Build a baseline from the current findings, skipping non-suppressible ones.
 * Entries surviving from `previous` keep their addedAt/reason/expires; entries
 * no longer observed are pruned.
 */
export function buildBaseline(
  reports: PackageReport[],
  toolVersion: string,
  now: Date,
  previous?: BaselineFile | null,
): BuiltBaseline {
  const today = now.toISOString().slice(0, 10);
  const kept = new Map<string, BaselineEntry>();
  const skipped: string[] = [];
  const carried = new Map<string, BaselineEntry>(
    (previous?.entries ?? []).map((entry) => [entryKey(entry.code, entry.package), entry]),
  );

  for (const pkg of reports) {
    for (const finding of pkg.findings) {
      const code = codeOf(finding);
      if (isLocked(finding, pkg)) {
        skipped.push(`${code} (${pkg.key})`);
        continue;
      }
      const key = entryKey(code, pkg.name);
      if (kept.has(key)) continue;
      const prior = carried.get(key);
      kept.set(key, {
        code,
        package: pkg.name,
        version: pkg.version,
        addedAt: prior?.addedAt ?? today,
        ...(prior?.reason !== undefined ? { reason: prior.reason } : {}),
        ...(prior?.expires !== undefined ? { expires: prior.expires } : {}),
      });
    }
  }

  let pruned = 0;
  for (const key of carried.keys()) {
    if (!kept.has(key)) pruned += 1;
  }

  const entries = [...kept.values()].sort(
    (a, b) => a.package.localeCompare(b.package) || a.code.localeCompare(b.code),
  );
  return {
    file: { version: 1, generatedAt: today, tool: `lockwarden@${toolVersion}`, entries },
    skipped,
    pruned,
  };
}

/** Serialize and write a baseline file (trailing newline, 2-space indent). */
export async function writeBaseline(path: string, file: BaselineFile): Promise<void> {
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}
