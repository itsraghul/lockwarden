/**
 * OSV-snapshot gate, run by .github/workflows/osv-refresh.yml
 * (and locally: node --experimental-strip-types scripts/validate-osv-snapshot.ts).
 *
 * 1. Validates the wrapper shape of src/data/osv-npm-snapshot.json
 *    (hand-rolled checks — no schema-validator dependency).
 * 2. Asserts every keep-list entry survived the merge (canonical incident
 *    ids can never vanish — tests and users depend on them).
 * 3. Self-tests the built CLI: an audit over a lockfile containing a
 *    keep-list package must exit 1 with the LW2-OSV code; a clean lockfile
 *    must exit 0.
 * Exits non-zero (with a reason) if the snapshot must not ship.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BUDGET_BYTES = 1_500_000;
const SUMMARY_MAX = 140;

const repoRoot = resolve(import.meta.dirname, '..');
const SNAPSHOT_PATH = resolve(repoRoot, 'packages/cli/src/data/osv-npm-snapshot.json');
const KEEP_PATH = resolve(repoRoot, 'packages/cli/src/data/osv-keep.json');

function fail(msg: string): never {
  console.error(`✗ snapshot invalid: ${msg}`);
  process.exit(1);
}

interface OsvEntry {
  id: string;
  package: string;
  versions?: string[];
  ranges?: string[];
  summary: string;
}

interface Wrapper {
  schemaVersion: number;
  generatedAt: string;
  source: string;
  windowMonths: number | null;
  entries: OsvEntry[];
}

const raw = readFileSync(SNAPSHOT_PATH, 'utf8');
if (Buffer.byteLength(raw) > BUDGET_BYTES) {
  fail(`serialized snapshot is ${Buffer.byteLength(raw)} bytes (budget ${BUDGET_BYTES})`);
}
let wrapper: Wrapper;
try {
  wrapper = JSON.parse(raw) as Wrapper;
} catch (e) {
  fail(`not valid JSON: ${String(e)}`);
}

// ── shape checks ─────────────────────────────────────────────────────────────
if (wrapper.schemaVersion !== 1) fail('schemaVersion must be 1');
if (!/^\d{4}-\d{2}-\d{2}$/.test(wrapper.generatedAt ?? '')) fail('generatedAt must be YYYY-MM-DD');
if (typeof wrapper.source !== 'string' || wrapper.source === '') fail('source must be non-empty');
if (wrapper.windowMonths !== null && typeof wrapper.windowMonths !== 'number') {
  fail('windowMonths must be a number or null');
}
if (!Array.isArray(wrapper.entries) || wrapper.entries.length === 0) {
  fail('entries must be a non-empty array');
}
for (const entry of wrapper.entries) {
  if (!/^MAL-/.test(entry.id ?? '')) fail(`entry id must start with MAL-: ${entry.id}`);
  if (typeof entry.package !== 'string' || entry.package === '') {
    fail(`entry ${entry.id}: package must be non-empty`);
  }
  const versions = entry.versions ?? [];
  const ranges = entry.ranges ?? [];
  if (versions.length === 0 && ranges.length === 0) {
    fail(`entry ${entry.id} (${entry.package}): needs versions[] or ranges[]`);
  }
  for (const v of [...versions, ...ranges]) {
    if (typeof v !== 'string' || v === '') fail(`entry ${entry.id}: empty version/range`);
  }
  if (typeof entry.summary !== 'string' || entry.summary === '') {
    fail(`entry ${entry.id} (${entry.package}): summary must be non-empty`);
  }
  if (entry.summary.length > SUMMARY_MAX) {
    fail(`entry ${entry.id} (${entry.package}): summary exceeds ${SUMMARY_MAX} chars`);
  }
}
console.log(`✓ shape ok: ${wrapper.entries.length} entries, generated ${wrapper.generatedAt}`);

// ── keep-list survival ───────────────────────────────────────────────────────
const keepList = JSON.parse(readFileSync(KEEP_PATH, 'utf8')) as OsvEntry[];
const present = new Set(wrapper.entries.map((e) => `${e.id} ${e.package}`));
for (const keep of keepList) {
  if (!present.has(`${keep.id} ${keep.package}`)) {
    fail(`keep-list entry missing from snapshot: ${keep.id} (${keep.package})`);
  }
}
console.log(`✓ keep-list intact: ${keepList.length} entries present`);

// ── self-test against the built CLI ─────────────────────────────────────────
const cli = join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
if (!existsSync(cli)) fail(`built CLI not found at ${cli} — run \`pnpm build\` first`);

function lockfileWith(pkgs: Record<string, string>): string {
  const packages: Record<string, unknown> = { '': { name: 'osv-selftest', version: '1.0.0' } };
  for (const [name, version] of Object.entries(pkgs)) {
    packages[`node_modules/${name}`] = { version, resolved: '', integrity: '' };
  }
  return JSON.stringify({ name: 'osv-selftest', lockfileVersion: 3, packages }, null, 2);
}

function runAudit(dir: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [cli, '--json', 'audit'], {
      cwd: dir,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: 'pipe',
    }).toString('utf8');
    return { code: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer };
    return { code: err.status ?? -1, stdout: err.stdout?.toString('utf8') ?? '' };
  }
}

const work = mkdtempSync(join(tmpdir(), 'lw-osv-selftest-'));
try {
  const hitDir = join(work, 'hit');
  const cleanDir = join(work, 'clean');
  for (const [dir, pkgs] of [
    [hitDir, { 'plain-crypto-js': '1.0.0' }],
    [cleanDir, { 'left-pad': '1.3.0' }],
  ] as const) {
    execFileSync('mkdir', ['-p', dir]);
    writeFileSync(join(dir, 'package.json'), '{"name":"selftest","version":"1.0.0"}');
    writeFileSync(join(dir, 'package-lock.json'), lockfileWith(pkgs));
  }

  const hit = runAudit(hitDir);
  if (hit.code !== 1) fail(`self-test: hit fixture exited ${hit.code}, expected 1`);
  if (!hit.stdout.includes('LW2-OSV-MAL-2026-0117')) {
    fail('self-test: hit fixture JSON does not contain LW2-OSV-MAL-2026-0117');
  }
  console.log('✓ self-test hit: plain-crypto-js@1.0.0 → exit 1 with LW2-OSV-MAL-2026-0117');

  const clean = runAudit(cleanDir);
  if (clean.code !== 0) fail(`self-test: clean fixture exited ${clean.code}, expected 0`);
  console.log('✓ self-test clean: exit 0');
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('✓ snapshot is shippable');
