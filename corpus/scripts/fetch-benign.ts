import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fetch benign calibration tarballs from the npm registry. The ONLY corpus
 * script permitted to touch the network (via native fetch). For each package:
 * pick dist-tags.latest as CURRENT and the highest DIFFERENT version below it
 * as PREVIOUS, download both tarballs into corpus/cache/<name>/, and record
 * pins.json { name, current, previous, integrity }.
 *
 * Idempotent/resumable (skips existing files), concurrency 8, one retry.
 * Writes nothing outside corpus/cache/. Run:
 *   node --experimental-strip-types scripts/fetch-benign.ts [--limit N]
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CACHE = path.join(ROOT, 'cache');
const CONCURRENCY = 8;

function sanitize(name: string): string {
  return name.replace(/[/@]/g, '_');
}

function parseVersion(v: string): number[] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (m === null) return undefined; // ignore prereleases for stability
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

interface VersionMeta {
  version: string;
  dist?: { tarball?: string; integrity?: string; shasum?: string };
}

async function fetchJson(url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 1) throw err;
    }
  }
  throw new Error('unreachable');
}

async function download(url: string, dest: string): Promise<Buffer> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(dest, buf);
      return buf;
    } catch (err) {
      if (attempt === 1) throw err;
    }
  }
  throw new Error('unreachable');
}

interface Pin {
  name: string;
  current: string;
  previous: string | null;
  integrity: { current?: string; previous?: string };
}

async function fetchOne(name: string): Promise<string> {
  const dir = path.join(CACHE, sanitize(name));
  await mkdir(dir, { recursive: true });
  const pinsPath = path.join(dir, 'pins.json');
  const currentTgz = path.join(dir, 'current.tgz');
  const previousTgz = path.join(dir, 'previous.tgz');

  if ((await exists(pinsPath)) && (await exists(currentTgz))) {
    return `skip ${name} (cached)`;
  }

  const meta = (await fetchJson(
    `https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`,
  )) as {
    'dist-tags'?: Record<string, string>;
    versions?: Record<string, VersionMeta>;
  };
  const latest = meta['dist-tags']?.latest;
  const versions = meta.versions ?? {};
  if (latest === undefined || versions[latest] === undefined) {
    return `FAIL ${name}: no latest version`;
  }

  const latestParsed = parseVersion(latest);
  let previous: string | null = null;
  if (latestParsed !== undefined) {
    let best: { v: string; parsed: number[] } | undefined;
    for (const [v, m] of Object.entries(versions)) {
      const parsed = parseVersion(v);
      if (parsed === undefined || m.dist?.tarball === undefined) continue;
      if (cmp(parsed, latestParsed) >= 0) continue;
      if (best === undefined || cmp(parsed, best.parsed) > 0) best = { v, parsed };
    }
    previous = best?.v ?? null;
  }

  const pin: Pin = { name, current: latest, previous, integrity: {} };

  const currentDist = versions[latest]?.dist;
  if (currentDist?.tarball !== undefined && !(await exists(currentTgz))) {
    const buf = await download(currentDist.tarball, currentTgz);
    pin.integrity.current =
      currentDist.integrity ?? `sha1-${createHash('sha1').update(buf).digest('base64')}`;
  }
  if (previous !== null) {
    const prevDist = versions[previous]?.dist;
    if (prevDist?.tarball !== undefined && !(await exists(previousTgz))) {
      const buf = await download(prevDist.tarball, previousTgz);
      pin.integrity.previous =
        prevDist.integrity ?? `sha1-${createHash('sha1').update(buf).digest('base64')}`;
    }
  }

  await writeFile(pinsPath, `${JSON.stringify(pin, null, 2)}\n`);
  return `ok   ${name}@${latest}${previous ? ` (prev ${previous})` : ' (no previous)'}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : Number.POSITIVE_INFINITY;

  const manifest = JSON.parse(
    await readFile(path.join(ROOT, 'manifest', 'benign-top500.json'), 'utf8'),
  );
  const names: string[] = manifest.packages.slice(0, limit);
  await mkdir(CACHE, { recursive: true });

  const results: string[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < names.length) {
      const name = names[cursor++] as string;
      try {
        results.push(await fetchOne(name));
      } catch (err) {
        results.push(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  for (const line of results.sort()) console.log(line);
  const ok = results.filter((r) => r.startsWith('ok') || r.startsWith('skip')).length;
  const fail = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\nfetch-benign: ${ok} ready, ${fail} failed, ${names.length} requested`);
}

main().catch((err) => {
  console.error('fetch-benign failed:', err);
  process.exit(1);
});
