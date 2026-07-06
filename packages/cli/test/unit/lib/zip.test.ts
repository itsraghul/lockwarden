import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readZip } from '../../../src/lib/zip.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.resolve(HERE, '..', '..', 'fixtures', 'artifacts');

/* ------------- minimal in-test zip builder (writer lives dev-side) ------------- */

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface Entry {
  path: string;
  data: string;
  method: 0 | 8;
  /** unix mode planted in external attributes (default: regular file) */
  mode?: number;
}

function makeZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data, 'utf8');
    const compressed = entry.method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.path, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by unix
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += 30 + name.length + compressed.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, eocd]);
}

/**
 * Wrap a classic zip as zip64: real values move to the zip64 EOCD record
 * (+locator), the classic EOCD carries overflow sentinels — the exact shape
 * of archives with >65,535 entries (e.g. the OSV all.zip).
 */
function makeZip64(entries: Entry[]): Buffer {
  const classic = makeZip(entries);
  const body = classic.subarray(0, classic.length - 22);
  const eocdClassic = classic.subarray(classic.length - 22);
  const realEntries = eocdClassic.readUInt16LE(10);
  const realCdSize = eocdClassic.readUInt32LE(12);
  const realCdOffset = eocdClassic.readUInt32LE(16);

  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4); // size of remainder
  record.writeUInt16LE(45, 12); // version made by
  record.writeUInt16LE(45, 14); // version needed
  record.writeBigUInt64LE(BigInt(realEntries), 24); // entries on this disk
  record.writeBigUInt64LE(BigInt(realEntries), 32); // total entries
  record.writeBigUInt64LE(BigInt(realCdSize), 40);
  record.writeBigUInt64LE(BigInt(realCdOffset), 48);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(body.length), 8); // record sits right after body
  locator.writeUInt32LE(1, 16); // total disks

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);

  return Buffer.concat([body, record, locator, eocd]);
}

/** Byte offset of the first central-directory entry (for corruption tests). */
function centralDirOffset(zip: Buffer): number {
  for (let pos = 0; pos + 4 <= zip.length; pos++) {
    if (zip.readUInt32LE(pos) === 0x02014b50) return pos;
  }
  throw new Error('no central directory in test zip');
}

describe('readZip', () => {
  it('round-trips stored and deflated entries with paths, sizes and content', () => {
    const big = 'const x = 1;\n'.repeat(200);
    const zip = makeZip([
      { path: 'package.json', data: '{"name":"z","version":"1.0.0"}', method: 0 },
      { path: 'lib/index.js', data: big, method: 8 },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.path)).toEqual(['package.json', 'lib/index.js']);
    const manifest = entries[0];
    expect(manifest?.size).toBe(manifest?.data.length);
    expect(manifest?.data.toString('utf8')).toBe('{"name":"z","version":"1.0.0"}');
    const deflated = entries[1];
    expect(deflated?.data.toString('utf8')).toBe(big);
    expect(deflated?.size).toBe(Buffer.byteLength(big));
  });

  it('decodes the committed app.zip fixture', async () => {
    const entries = readZip(await readFile(path.join(ARTIFACTS, 'app.zip')));
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('package.json');
    expect(paths).toContain('node_modules/a/package.json');
    expect(paths).toContain('node_modules/b/index.js');
    const manifest = entries.find((e) => e.path === 'node_modules/a/package.json');
    expect(manifest?.data.toString('utf8')).toContain('"a"');
  });

  it('skips directory and symlink entries', () => {
    const zip = makeZip([
      { path: 'dir/', data: '', method: 0, mode: 0o40755 },
      { path: 'dir/file.txt', data: 'hello', method: 0 },
      { path: 'dir/link', data: 'file.txt', method: 0, mode: 0o120777 },
    ]);
    expect(readZip(zip).map((e) => e.path)).toEqual(['dir/file.txt']);
  });

  it('rejects entry paths containing ".." segments', () => {
    const zip = makeZip([{ path: '../escape.txt', data: 'nope', method: 0 }]);
    expect(() => readZip(zip)).toThrow(/"\.\." segment/);
  });

  it('normalizes backslashes and leading ./ in entry paths', () => {
    const zip = makeZip([{ path: './a\\b.txt', data: 'x', method: 0 }]);
    expect(readZip(zip).map((e) => e.path)).toEqual(['a/b.txt']);
  });

  it('decodes zip64 archives (sentinel EOCD + zip64 record)', () => {
    const zip = makeZip64([
      { path: 'package.json', data: '{"name":"z64","version":"1.0.0"}', method: 0 },
      { path: 'lib/index.js', data: 'module.exports = 64;\n', method: 8 },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.path)).toEqual(['package.json', 'lib/index.js']);
    expect(entries[1]?.data.toString('utf8')).toBe('module.exports = 64;\n');
  });

  it('fails clearly on a sentinel EOCD with no zip64 locator', () => {
    const zip = makeZip([{ path: 'a.txt', data: 'x', method: 0 }]);
    // EOCD is the last 22 bytes; force totalEntries to the zip64 sentinel.
    zip.writeUInt16LE(0xffff, zip.length - 22 + 10);
    expect(() => readZip(zip)).toThrow(/locator not found/);
  });

  it('fails clearly on a corrupt zip64 EOCD record signature', () => {
    const zip = makeZip64([{ path: 'a.txt', data: 'x', method: 0 }]);
    // The zip64 record starts 56+20+22 bytes from the end; corrupt its signature.
    zip.writeUInt32LE(0xdeadbeef, zip.length - 98);
    expect(() => readZip(zip)).toThrow(/bad EOCD64 record signature/);
  });

  it('fails clearly on zip64 per-entry sentinels', () => {
    const zip = makeZip([{ path: 'a.txt', data: 'x', method: 0 }]);
    const cd = centralDirOffset(zip);
    zip.writeUInt32LE(0xffffffff, cd + 20); // compressed size sentinel
    expect(() => readZip(zip)).toThrow(/zip64 entry sizes\/offsets are not supported/);
  });

  it('fails clearly on encrypted entries', () => {
    const zip = makeZip([{ path: 'a.txt', data: 'x', method: 0 }]);
    const cd = centralDirOffset(zip);
    zip.writeUInt16LE(0x0001, cd + 8); // set the encryption flag bit
    expect(() => readZip(zip)).toThrow(/encrypted zip entries are not supported/);
  });

  it('fails clearly on unsupported compression methods', () => {
    const zip = makeZip([{ path: 'a.txt', data: 'x', method: 0 }]);
    const cd = centralDirOffset(zip);
    zip.writeUInt16LE(12, cd + 10); // bzip2
    expect(() => readZip(zip)).toThrow(/unsupported zip compression method 12/);
  });

  it('rejects non-zip input', () => {
    expect(() => readZip(Buffer.from('definitely not a zip archive'))).toThrow(
      /no end-of-central-directory/,
    );
  });
});
