import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ExecError } from '../exit.js';
import { request } from './net.js';

/**
 * Content cache for registry tarballs fetched during --diff/--deep delta
 * comparison. Keyed by sha256(url) so the same previous-version tarball is
 * fetched at most once across runs. A warm cache also makes --offline
 * delta runs possible: cache hits never touch the network, so only an
 * actually-required fetch trips the offline guarantee.
 *
 * All network flows through lib/net.ts request() — never fetch directly.
 */

function cacheDir(): string {
  return process.env.LOCKWARDEN_CACHE_DIR ?? join(homedir(), '.lockwarden', 'cache');
}

/** SRI algorithms we can verify locally. */
const SRI_ALGOS = new Set(['sha512', 'sha384', 'sha256', 'sha1']);

/**
 * Verify an SRI integrity string ("sha512-BASE64", possibly several
 * space-separated entries) against the downloaded bytes. The first entry
 * with a known algorithm is checked; a mismatch is an ExecError (exit 2) —
 * a tarball that fails its own lockfile integrity is exactly the tampering
 * lockwarden exists to catch, so we refuse to analyze or cache it.
 */
function verifyIntegrity(data: Buffer, integrity: string, url: string): void {
  for (const entry of integrity.split(/\s+/)) {
    const dash = entry.indexOf('-');
    if (dash <= 0) continue;
    const algo = entry.slice(0, dash);
    if (!SRI_ALGOS.has(algo)) continue;
    const expected = entry.slice(dash + 1);
    const actual = createHash(algo).update(data).digest('base64');
    if (actual !== expected) {
      throw new ExecError(
        `integrity mismatch for ${url}`,
        `lockfile says ${entry}, downloaded bytes hash to ${algo}-${actual}`,
      );
    }
    return; // first verifiable entry checked and passed
  }
}

/**
 * Return the tarball bytes for a URL, from ~/.lockwarden/cache (override:
 * LOCKWARDEN_CACHE_DIR) when present, otherwise via a single network fetch.
 * Integrity, when given, is verified before anything is written to disk.
 */
export async function cachedTarball(url: string, integrity?: string): Promise<Buffer> {
  const dir = cacheDir();
  const path = join(dir, `${createHash('sha256').update(url).digest('hex')}.tgz`);

  try {
    return await readFile(path);
  } catch {
    // cache miss — fall through to the network
  }

  const response = await request(url);
  if (!response.ok) {
    throw new ExecError(`failed to fetch ${url}: HTTP ${response.status}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (integrity !== undefined) verifyIntegrity(data, integrity, url);

  await mkdir(dir, { recursive: true });
  await writeFile(path, data);
  return data;
}
