import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OfflineViolationError } from '../../src/exit.js';
import { isOffline, request, setOffline } from '../../src/lib/net.js';

const SRC = join(fileURLToPath(import.meta.url), '..', '..', '..', 'src');

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

describe('offline guarantee — structural', () => {
  it('lib/net.ts is the only source file referencing fetch', () => {
    const offenders = walk(SRC).filter((file) => {
      if (file.endsWith(`lib${'/'}net.ts`)) return false;
      const source = readFileSync(file, 'utf8');
      return /\bfetch\s*\(/.test(source) || /\bglobalThis\.fetch\b/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});

describe('offline guarantee — behavioral', () => {
  it('request() throws OfflineViolationError before touching the network when offline', async () => {
    setOffline(true);
    try {
      expect(isOffline()).toBe(true);
      // The test-global fetch stub would also throw, but the offline check
      // must fire FIRST — the error type proves no dispatch was attempted.
      await expect(request('https://registry.npmjs.org/x')).rejects.toBeInstanceOf(
        OfflineViolationError,
      );
    } finally {
      setOffline(false);
    }
  });

  it('request() reaches the (stubbed, throwing) fetch when online', async () => {
    setOffline(false);
    await expect(request('https://registry.npmjs.org/x')).rejects.toThrow(
      /Network access attempted during tests/,
    );
  });
});
