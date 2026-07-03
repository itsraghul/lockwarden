import { gunzipSync } from 'node:zlib';

/**
 * Read-only tar.gz reader — zero dependencies, never extracts to disk.
 *
 * Deliberately minimal: lockwarden only ever READS registry tarballs and
 * artifact archives into memory for analysis. Supported entry types:
 *   - regular files ('0' and '\0')
 *   - directories ('5', skipped)
 *   - PAX extended headers ('x', `path=` records override the next entry)
 *   - GNU longname ('L')
 * Everything else (symlinks, hardlinks, devices, FIFOs) is skipped without
 * recording anything — we never materialize entries, so link tricks are moot.
 *
 * Security: paths are normalized to posix and any entry containing a `..`
 * segment throws. A supply-chain auditor must not be traversal-prone even
 * though we never write extracted entries to disk.
 */

export interface TarFileEntry {
  /** normalized posix path exactly as recorded in the archive */
  path: string;
  size: number;
  data: Buffer;
}

const BLOCK = 512;

function isZeroBlock(buf: Buffer, offset: number): boolean {
  for (let i = offset; i < offset + BLOCK; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

/** Read a NUL-terminated string field out of a header block. */
function field(buf: Buffer, offset: number, length: number): string {
  let end = offset;
  const max = offset + length;
  while (end < max && buf[end] !== 0) end++;
  return buf.toString('utf8', offset, end);
}

/** Parse an octal numeric header field; supports GNU base-256 for large values. */
function numeric(buf: Buffer, offset: number, length: number): number {
  const first = buf[offset];
  if (first !== undefined && (first & 0x80) !== 0) {
    // GNU base-256 encoding
    let value = first & 0x7f;
    for (let i = offset + 1; i < offset + length; i++) {
      value = value * 256 + (buf[i] ?? 0);
    }
    return value;
  }
  const text = field(buf, offset, length).trim();
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  if (Number.isNaN(value) || value < 0) {
    throw new Error(`malformed tar archive: invalid numeric field at byte ${offset}`);
  }
  return value;
}

/** Parse PAX extended header records: "<len> <key>=<value>\n" repeated. */
function parsePax(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let pos = 0;
  while (pos < data.length) {
    let sp = pos;
    while (sp < data.length && data[sp] !== 0x20) sp++;
    if (sp >= data.length) break;
    const len = Number.parseInt(data.toString('utf8', pos, sp), 10);
    if (Number.isNaN(len) || len <= 0 || pos + len > data.length) {
      throw new Error('malformed tar archive: invalid PAX record length');
    }
    // record is "<len> <key>=<value>\n" and len counts the whole record
    const body = data.toString('utf8', sp + 1, pos + len - 1);
    const eq = body.indexOf('=');
    if (eq > 0) {
      records.set(body.slice(0, eq), body.slice(eq + 1));
    }
    pos += len;
  }
  return records;
}

/** Normalize to posix, strip leading ./ and /, reject traversal segments. */
function normalizePath(raw: string): string {
  let p = raw.replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  const segments = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) {
    throw new Error(`malformed tar archive: entry path contains ".." segment: ${raw}`);
  }
  return segments.join('/');
}

/**
 * Decode a gzipped tar archive fully in memory and return its regular files.
 * Throws a plain Error with a clear message on malformed input — callers wrap.
 */
export async function readTarGz(data: Buffer): Promise<TarFileEntry[]> {
  let tar: Buffer;
  try {
    tar = gunzipSync(data);
  } catch (err) {
    throw new Error(`not a valid gzip stream: ${err instanceof Error ? err.message : String(err)}`);
  }

  const entries: TarFileEntry[] = [];
  let offset = 0;
  let pendingLongName: string | undefined;
  let pendingPaxPath: string | undefined;

  while (offset + BLOCK <= tar.length) {
    if (isZeroBlock(tar, offset)) {
      // end-of-archive: two consecutive zero blocks (be lenient about the
      // second one being truncated away by the producer)
      break;
    }

    const typeflag = tar[offset + 156] ?? 0;
    const size = numeric(tar, offset + 124, 12);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new Error('malformed tar archive: entry data extends past end of archive');
    }
    const paddedEnd = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    const type = String.fromCharCode(typeflag);
    if (type === 'x' || type === 'X') {
      // PAX extended header applying to the next entry
      const records = parsePax(tar.subarray(dataStart, dataEnd));
      const paxPath = records.get('path');
      if (paxPath !== undefined) pendingPaxPath = paxPath;
    } else if (type === 'L') {
      // GNU longname: data block holds the next entry's name
      pendingLongName = field(tar, dataStart, size);
    } else if (type === '0' || typeflag === 0) {
      let name = pendingPaxPath ?? pendingLongName;
      if (name === undefined) {
        const base = field(tar, offset, 100);
        const prefix = field(tar, offset + 345, 155);
        name = prefix !== '' ? `${prefix}/${base}` : base;
      }
      const path = normalizePath(name);
      if (path !== '') {
        entries.push({ path, size, data: tar.subarray(dataStart, dataEnd) });
      }
      pendingLongName = undefined;
      pendingPaxPath = undefined;
    } else {
      // directories ('5'), symlinks ('2'), hardlinks ('1'), globals ('g'),
      // devices, FIFOs — skipped. We never extract, so links record nothing.
      pendingLongName = undefined;
      pendingPaxPath = undefined;
    }

    offset = paddedEnd;
  }

  return entries;
}
