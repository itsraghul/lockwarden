/**
 * Incident-bundle gate, run by .github/workflows/incident-bundle.yml
 * (and locally: node --experimental-strip-types scripts/validate-incident-bundle.ts <bundle.json>).
 *
 * 1. Validates the bundle against the shape of src/data/incidents/_schema.json
 *    (hand-rolled checks — no schema-validator dependency).
 * 2. Self-tests the built CLI against generated fixtures:
 *    a lockfile CONTAINING a listed package must exit 1,
 *    a clean lockfile must exit 0.
 * Exits non-zero (with a reason) if the bundle must not ship.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const bundlePath = process.argv[2];
if (!bundlePath) {
  console.error('usage: validate-incident-bundle.ts <path-to-bundle.json>');
  process.exit(1);
}

interface Bundle {
  id: string;
  name: string;
  date: string;
  summary: string;
  references?: string[];
  packages: Array<{ name: string; versions?: string[]; ranges?: string[] }>;
  fileIocs?: Array<{ path: string; sha256: string }>;
}

function fail(msg: string): never {
  console.error(`✗ bundle invalid: ${msg}`);
  process.exit(1);
}

const raw = readFileSync(bundlePath, 'utf8');
let bundle: Bundle;
try {
  bundle = JSON.parse(raw) as Bundle;
} catch (e) {
  fail(`not valid JSON: ${String(e)}`);
}

// ── shape checks (mirror _schema.json) ──────────────────────────────────────
if (!/^[a-z0-9][a-z0-9-]*$/.test(bundle.id ?? '')) fail('id must match ^[a-z0-9][a-z0-9-]*$');
for (const field of ['name', 'date', 'summary'] as const) {
  if (typeof bundle[field] !== 'string' || bundle[field].length === 0) {
    fail(`missing required string field "${field}"`);
  }
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(bundle.date)) fail('date must be YYYY-MM-DD');
if (!Array.isArray(bundle.packages) || bundle.packages.length === 0) {
  fail('packages must be a non-empty array');
}
for (const pkg of bundle.packages) {
  if (typeof pkg.name !== 'string' || pkg.name.length === 0) fail('every package needs a name');
  const versions = pkg.versions ?? [];
  const ranges = pkg.ranges ?? [];
  if (versions.length === 0 && ranges.length === 0) {
    fail(`package "${pkg.name}" needs versions[] or ranges[]`);
  }
}
for (const ioc of bundle.fileIocs ?? []) {
  if (!/^[a-f0-9]{64}$/.test(ioc.sha256 ?? '')) fail(`fileIoc "${ioc.path}": bad sha256`);
}
console.log(`✓ shape ok: ${bundle.id} (${bundle.packages.length} package entries)`);

// ── self-test against the built CLI ─────────────────────────────────────────
const repoRoot = resolve(import.meta.dirname, '..');
const cli = join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
if (!existsSync(cli)) fail(`built CLI not found at ${cli} — run \`pnpm build\` first`);
const incidentDir = resolve(bundlePath, '..');

const first = bundle.packages[0];
if (!first) fail('unreachable: packages empty');
// A concrete version that the bundle matches: prefer an exact version; for
// range-only entries use a plausible in-range pin ('*' → 1.0.0).
const hitVersion =
  first.versions?.[0] ??
  (first.ranges?.[0] === '*' ? '1.0.0' : (first.ranges?.[0] ?? '1.0.0').replace(/^[~^>=<\s]+/, ''));

function lockfileWith(pkgs: Record<string, string>): string {
  const packages: Record<string, unknown> = {
    '': { name: 'incident-selftest', version: '1.0.0' },
  };
  for (const [name, version] of Object.entries(pkgs)) {
    packages[`node_modules/${name}`] = { version, resolved: '', integrity: '' };
  }
  return JSON.stringify({ name: 'incident-selftest', lockfileVersion: 3, packages }, null, 2);
}

function runCheck(dir: string): number {
  try {
    execFileSync(process.execPath, [cli, 'check', '--incident', bundle.id, '--ci'], {
      cwd: dir,
      env: { ...process.env, LOCKWARDEN_INCIDENT_DIR: incidentDir, NO_COLOR: '1' },
      stdio: 'pipe',
    });
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

const work = mkdtempSync(join(tmpdir(), 'lw-incident-selftest-'));
try {
  const hitDir = join(work, 'hit');
  const cleanDir = join(work, 'clean');
  for (const [dir, pkgs] of [
    [hitDir, { [first.name]: hitVersion }],
    [cleanDir, { 'left-pad': '1.3.0' }],
  ] as const) {
    execFileSync('mkdir', ['-p', dir]);
    writeFileSync(join(dir, 'package.json'), '{"name":"selftest","version":"1.0.0"}');
    writeFileSync(join(dir, 'package-lock.json'), lockfileWith(pkgs));
  }

  const hitExit = runCheck(hitDir);
  if (hitExit !== 1)
    fail(`self-test: hit fixture (${first.name}@${hitVersion}) exited ${hitExit}, expected 1`);
  console.log(`✓ self-test hit: ${first.name}@${hitVersion} → exit 1`);

  const cleanExit = runCheck(cleanDir);
  if (cleanExit !== 0) fail(`self-test: clean fixture exited ${cleanExit}, expected 0`);
  console.log('✓ self-test clean: exit 0');
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`✓ bundle ${bundle.id} is shippable`);
