import { inflateRawSync } from 'node:zlib';

/**
 * Read-only zip reader — zero dependencies, never extracts to disk. Used by
 * `scan` for zip artifacts (fat jars of the JS world: lambda bundles, release
 * archives with vendored node_modules).
 *
 * Deliberately minimal: locate the end-of-central-directory record, walk the
 * central directory, decode stored (method 0) and deflated (method 8)
 * entries. Directories and symlinks are skipped; encrypted entries and
 * zip64 archives fail with a clear error rather than being silently
 * mis-read.
 *
 * Security: paths are normalized to posix and any entry containing a `..`
 * segment throws — same rule as lib/tar.ts.
 */

export interface ZipEntry {
  /** normalized posix path exactly as recorded in the archive */
  path: string;
  size: number;
  data: Buffer;
}

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** EOCD is 22 bytes + up to 65535 bytes of trailing comment. */
const EOCD_MIN = 22;
const EOCD_SEARCH_MAX = EOCD_MIN + 0xffff;

function findEocd(data: Buffer): number {
  const lowest = Math.max(0, data.length - EOCD_SEARCH_MAX);
  for (let pos = data.length - EOCD_MIN; pos >= lowest; pos--) {
    if (data.readUInt32LE(pos) === EOCD_SIG) return pos;
  }
  throw new Error('not a valid zip archive: no end-of-central-directory record found');
}

/** Normalize to posix, strip leading ./ and /, reject traversal segments. */
function normalizePath(raw: string): string {
  let p = raw.replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  const segments = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) {
    throw new Error(`malformed zip archive: entry path contains ".." segment: ${raw}`);
  }
  return segments.join('/');
}

const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;
const S_IFDIR = 0x4000;
/** MS-DOS directory attribute bit (low byte of external attributes). */
const DOS_DIR = 0x10;

/**
 * Decode a zip archive fully in memory and return its regular files.
 * Throws a plain Error with a clear message on malformed/unsupported input —
 * callers wrap into ExecError.
 */
export function readZip(data: Buffer): ZipEntry[] {
  const eocd = findEocd(data);
  const totalEntries = data.readUInt16LE(eocd + 10);
  const cdSize = data.readUInt32LE(eocd + 12);
  const cdOffset = data.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('zip64 archives are not supported');
  }

  const entries: ZipEntry[] = [];
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > data.length || data.readUInt32LE(pos) !== CDIR_SIG) {
      throw new Error('malformed zip archive: bad central directory entry');
    }
    const versionMadeBy = data.readUInt16LE(pos + 4);
    const flags = data.readUInt16LE(pos + 8);
    const method = data.readUInt16LE(pos + 10);
    const compSize = data.readUInt32LE(pos + 20);
    const uncompSize = data.readUInt32LE(pos + 24);
    const nameLen = data.readUInt16LE(pos + 28);
    const extraLen = data.readUInt16LE(pos + 30);
    const commentLen = data.readUInt16LE(pos + 32);
    const externalAttrs = data.readUInt32LE(pos + 38);
    const localOffset = data.readUInt32LE(pos + 42);
    const rawName = data.toString('utf8', pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;

    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('zip64 archives are not supported');
    }
    if ((flags & 0x1) !== 0) {
      throw new Error(`encrypted zip entries are not supported: ${rawName}`);
    }

    // Directories: trailing slash, DOS dir bit, or Unix S_IFDIR mode.
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    const madeByUnix = versionMadeBy >> 8 === 3;
    if (
      rawName.endsWith('/') ||
      (externalAttrs & DOS_DIR) !== 0 ||
      (madeByUnix && (unixMode & S_IFMT) === S_IFDIR)
    ) {
      continue;
    }
    // Symlinks: never followed, never recorded — same policy as lib/tar.ts.
    if (madeByUnix && (unixMode & S_IFMT) === S_IFLNK) continue;

    // Local header: name/extra lengths there may differ from the central
    // directory's; the data begins after the LOCAL lengths.
    if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`malformed zip archive: bad local header for ${rawName}`);
    }
    const localNameLen = data.readUInt16LE(localOffset + 26);
    const localExtraLen = data.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > data.length) {
      throw new Error(`malformed zip archive: entry data extends past end of archive: ${rawName}`);
    }

    let content: Buffer;
    if (method === 0) {
      content = data.subarray(dataStart, dataEnd);
    } else if (method === 8) {
      try {
        content = inflateRawSync(data.subarray(dataStart, dataEnd));
      } catch (err) {
        throw new Error(
          `malformed zip archive: failed to inflate ${rawName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      throw new Error(`unsupported zip compression method ${method} for ${rawName}`);
    }
    if (content.length !== uncompSize) {
      throw new Error(
        `malformed zip archive: ${rawName} decoded to ${content.length} bytes, expected ${uncompSize}`,
      );
    }

    const path = normalizePath(rawName);
    if (path === '') continue;
    entries.push({ path, size: content.length, data: content });
  }

  return entries;
}
