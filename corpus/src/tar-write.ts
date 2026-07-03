import { Buffer } from 'node:buffer';
import { gzipSync } from 'node:zlib';

/**
 * Minimal ustar WRITER — dev-side only, never ships in the CLI. Used by
 * corpus/scripts/build-malicious.ts and the CLI fixture builder to produce
 * synthetic package tarballs.
 *
 * All entries are rooted under `package/` (the npm convention). Output is
 * deterministic: fixed mtime 0, fixed uid/gid, no gzip timestamp — so
 * committed fixtures do not churn on regeneration.
 *
 * Paths whose full `package/<path>` form exceeds the 100-byte ustar name
 * field are emitted with a preceding PAX extended header (`path=` record),
 * which doubles as reader test coverage.
 */

const BLOCK = 512;

export interface TarWriteEntry {
  /** path inside the package — `package/` is prefixed automatically */
  path: string;
  data: Buffer | string;
}

function octal(value: number, length: number): Buffer {
  const buf = Buffer.alloc(length, 0);
  const text = value.toString(8).padStart(length - 1, '0');
  buf.write(text.slice(0, length - 1), 0, 'ascii');
  return buf;
}

function header(name: string, size: number, typeflag: string): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(name, 0, 100, 'utf8');
  octal(0o644, 8).copy(block, 100); // mode
  octal(0, 8).copy(block, 108); // uid
  octal(0, 8).copy(block, 116); // gid
  octal(size, 12).copy(block, 124); // size
  octal(0, 12).copy(block, 136); // mtime — fixed for determinism
  block.fill(0x20, 148, 156); // chksum placeholder: spaces
  block.write(typeflag, 156, 1, 'ascii');
  block.write('ustar', 257, 'ascii'); // magic (NUL-terminated by alloc)
  block.write('00', 263, 'ascii'); // version
  block.write('root', 265, 'utf8'); // uname
  block.write('root', 297, 'utf8'); // gname

  let sum = 0;
  for (const byte of block) sum += byte;
  const chk = Buffer.alloc(8, 0);
  chk.write(sum.toString(8).padStart(6, '0'), 0, 'ascii');
  chk[7] = 0x20; // "NNNNNN\0 "
  chk.copy(block, 148);
  return block;
}

function padded(data: Buffer): Buffer {
  const rem = data.length % BLOCK;
  if (rem === 0) return data;
  return Buffer.concat([data, Buffer.alloc(BLOCK - rem, 0)]);
}

function paxHeaderFor(fullPath: string): Buffer {
  // record = "<len> path=<value>\n" where len counts the entire record
  const body = ` path=${fullPath}\n`;
  let len = body.length + 1; // at least one digit
  while (`${len}${body}`.length !== len) len += 1;
  const record = Buffer.from(`${len}${body}`, 'utf8');
  // PAX header entry name is conventional/informational; keep it short
  return Buffer.concat([header('PaxHeader/entry', record.length, 'x'), padded(record)]);
}

export function writeTarGz(entries: TarWriteEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const fullPath = `package/${entry.path}`;
    if (Buffer.byteLength(fullPath, 'utf8') > 100) {
      parts.push(paxHeaderFor(fullPath));
      // the ustar name field still needs *something* parseable
      parts.push(header(fullPath.slice(0, 100), data.length, '0'));
    } else {
      parts.push(header(fullPath, data.length, '0'));
    }
    parts.push(padded(data));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0)); // end-of-archive
  return gzipSync(Buffer.concat(parts));
}
