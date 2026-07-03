import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readTarGz } from '../../../src/lib/tar.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', '..', 'fixtures', 'tarballs');

function fixture(rel: string): Promise<Buffer> {
  return readFile(path.join(FIXTURES, rel));
}

describe('readTarGz', () => {
  it('decodes a benign tarball into its regular files', async () => {
    const entries = await readTarGz(await fixture('lifecycle-scripts/benign.tgz'));
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(['package/index.js', 'package/package.json']);
    const manifest = entries.find((e) => e.path === 'package/package.json');
    expect(manifest?.size).toBe(manifest?.data.length);
    expect(manifest?.data.toString('utf8')).toContain('"lc-mini"');
  });

  it('records nested paths and skips directory entries', async () => {
    const entries = await readTarGz(await fixture('agent-hooks/malicious.tgz'));
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('package/.claude/settings.json');
    expect(paths).toContain('package/mcp.json');
    // no directory entries retained
    expect(paths.every((p) => !p.endsWith('/'))).toBe(true);
  });

  it('handles PAX extended headers for paths longer than 100 bytes', async () => {
    const entries = await readTarGz(await fixture('_readers/pax-longpath.tgz'));
    const long = entries.find((e) => e.path.endsWith('leaf.js'));
    expect(long).toBeDefined();
    // package/deeply/nested/segment-...leaf.js exceeds the 100-byte ustar name
    expect(long?.path.length).toBeGreaterThan(100);
    expect(long?.data.toString('utf8')).toContain("module.exports = 'long'");
  });

  it('throws a clear error on non-gzip input', async () => {
    await expect(readTarGz(Buffer.from('not a gzip stream'))).rejects.toThrow(/not a valid gzip/i);
  });

  it('rejects entries containing a ".." path segment', async () => {
    // hand-forge a single ustar header whose name escapes the archive root
    const block = Buffer.alloc(512, 0);
    block.write('package/../evil.js', 0, 'utf8');
    block.write('00000000000', 124, 'ascii'); // size 0 (octal)
    block.write('0', 156, 1, 'ascii'); // regular file
    block.write('ustar', 257, 'ascii');
    // checksum
    block.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of block) sum += b;
    block.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
    block[154] = 0;
    block[155] = 0x20;
    const archive = gzipSync(Buffer.concat([block, Buffer.alloc(1024, 0)]));
    await expect(readTarGz(archive)).rejects.toThrow(/\.\./);
  });
});
