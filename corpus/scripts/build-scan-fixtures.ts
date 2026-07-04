import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { INERT_MARKER, inflatedMainSource } from '../src/mutations.ts';
import { writeTarGz } from '../src/tar-write.ts';

/**
 * Generate the tiny INERT committed `scan` fixtures in
 * packages/cli/test/fixtures/artifacts/ plus the file-IOC test incident
 * bundle in packages/cli/test/fixtures/incidents/scan-ioc-test.json.
 * These are NOT real apps or images — synthetic minis that exercise the
 * artifact sniffers (tgz/zip/tar/docker-save), the embedded-root finder,
 * and the scan exit-code matrix. Regenerate with:
 *   node --experimental-strip-types corpus/scripts/build-scan-fixtures.ts
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '..', '..', 'packages', 'cli', 'test', 'fixtures');
const OUT = path.join(FIXTURES, 'artifacts');

/* --------------------- raw (non-gz, non-prefixed) tar --------------------- */

const BLOCK = 512;

interface RawTarEntry {
  path: string;
  data: Buffer | string;
}

function octal(value: number, length: number): Buffer {
  const buf = Buffer.alloc(length, 0);
  buf.write(
    value
      .toString(8)
      .padStart(length - 1, '0')
      .slice(0, length - 1),
    0,
    'ascii',
  );
  return buf;
}

function tarHeader(name: string, size: number): Buffer {
  if (Buffer.byteLength(name, 'utf8') > 100) {
    throw new Error(`rawTar fixture path exceeds 100 bytes: ${name}`);
  }
  const block = Buffer.alloc(BLOCK, 0);
  block.write(name, 0, 100, 'utf8');
  octal(0o644, 8).copy(block, 100); // mode
  octal(0, 8).copy(block, 108); // uid
  octal(0, 8).copy(block, 116); // gid
  octal(size, 12).copy(block, 124); // size
  octal(0, 12).copy(block, 136); // mtime — fixed for determinism
  block.fill(0x20, 148, 156); // chksum placeholder: spaces
  block.write('0', 156, 1, 'ascii'); // regular file
  block.write('ustar', 257, 'ascii');
  block.write('00', 263, 'ascii');
  block.write('root', 265, 'utf8');
  block.write('root', 297, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  const chk = Buffer.alloc(8, 0);
  chk.write(sum.toString(8).padStart(6, '0'), 0, 'ascii');
  chk[7] = 0x20;
  chk.copy(block, 148);
  return block;
}

function padded(data: Buffer): Buffer {
  const rem = data.length % BLOCK;
  return rem === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rem, 0)]);
}

/** Plain ustar tar: exact paths (no `package/` prefix), no gzip. */
function rawTar(entries: RawTarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    parts.push(tarHeader(entry.path, data.length), padded(data));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/* --------------------------------- zip ----------------------------------- */

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

interface ZipWriteEntry {
  path: string;
  data: Buffer | string;
  /** 0 = stored, 8 = deflated */
  method: 0 | 8;
}

/** Minimal deterministic zip writer: local headers + central dir + EOCD. */
function writeZip(entries: ZipWriteEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const compressed = entry.method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.path, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(0, 10); // mod time — fixed for determinism
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: unix
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0x21, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: unix regular file
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

/* ------------------------------- fixtures --------------------------------- */

function json(fields: Record<string, unknown> | unknown[]): string {
  return `${JSON.stringify(fields, null, 2)}\n`;
}

const INERT_JS = `${INERT_MARKER}module.exports = 1;\n`;

/** Shared clean-app entry list (paths artifact-relative, no top dir). */
function cleanAppEntries(): Array<{ path: string; data: string }> {
  return [
    {
      path: 'package.json',
      data: json({
        name: 'app-clean',
        version: '1.0.0',
        private: true,
        main: 'index.js',
        dependencies: { a: '^1.0.0', b: '^1.0.0' },
      }),
    },
    {
      path: 'index.js',
      data: `${INERT_MARKER}const a = require('a');\nconst b = require('b');\nmodule.exports = { a, b };\n`,
    },
    {
      path: 'node_modules/a/package.json',
      data: json({ name: 'a', version: '1.0.0', main: 'index.js' }),
    },
    { path: 'node_modules/a/index.js', data: INERT_JS },
    {
      path: 'node_modules/b/package.json',
      data: json({ name: 'b', version: '1.0.0', main: 'index.js' }),
    },
    { path: 'node_modules/b/index.js', data: INERT_JS },
  ];
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  // 1. app-clean.tgz — vendored node_modules/{a,b}, zero execution surface.
  //    writeTarGz roots entries under `package/` (npm convention top dir);
  //    the embedded-root finder must handle that prefix transparently.
  await writeFile(path.join(OUT, 'app-clean.tgz'), writeTarGz(cleanAppEntries()));

  // 2. app-baked-postinstall.tgz — a tampered dep pre-baked into
  //    node_modules: postinstall + hex-blob obfuscation in an install-path
  //    file. The lockfile never sees this; scan must.
  await writeFile(
    path.join(OUT, 'app-baked-postinstall.tgz'),
    writeTarGz([
      {
        path: 'package.json',
        data: json({
          name: 'app-baked',
          version: '1.0.0',
          private: true,
          main: 'index.js',
          dependencies: { 'evil-thing': '^1.0.0' },
        }),
      },
      { path: 'index.js', data: `${INERT_MARKER}module.exports = require('evil-thing');\n` },
      {
        path: 'node_modules/evil-thing/package.json',
        data: json({
          name: 'evil-thing',
          version: '1.0.1',
          main: 'index.js',
          scripts: { postinstall: 'node install.js' },
        }),
      },
      { path: 'node_modules/evil-thing/index.js', data: INERT_JS },
      { path: 'node_modules/evil-thing/install.js', data: inflatedMainSource(2500) },
    ]),
  );

  // 3. app.zip — the clean app as a zip: exercises lib/zip.ts end to end,
  //    with a mix of stored and deflated entries.
  await writeFile(
    path.join(OUT, 'app.zip'),
    writeZip(
      cleanAppEntries().map((entry, i) => ({
        path: entry.path,
        data: entry.data,
        method: i % 2 === 0 ? 8 : 0, // alternate deflated/stored
      })),
    ),
  );

  // 4. docker-save.tar — fake docker-save layout, 2 layers:
  //    layer 1 (dir-style path) adds node_modules/x@1.0.0 WITH postinstall;
  //    layer 2 (OCI blob-style path) REPLACES x's package.json without the
  //    postinstall (later layer wins → no lifecycle finding) and adds
  //    node_modules/plain-crypto-js@1.0.0 → Layer-2 critical.
  const layer1 = rawTar([
    {
      path: 'node_modules/x/package.json',
      data: json({
        name: 'x',
        version: '1.0.0',
        main: 'index.js',
        scripts: { postinstall: 'node install.js' },
      }),
    },
    { path: 'node_modules/x/index.js', data: INERT_JS },
    { path: 'node_modules/x/install.js', data: INERT_MARKER },
  ]);
  const layer2 = rawTar([
    {
      path: 'node_modules/x/package.json',
      data: json({ name: 'x', version: '1.0.0', main: 'index.js' }),
    },
    {
      path: 'node_modules/plain-crypto-js/package.json',
      data: json({ name: 'plain-crypto-js', version: '1.0.0', main: 'index.js' }),
    },
    { path: 'node_modules/plain-crypto-js/index.js', data: INERT_JS },
  ]);
  const layer2Digest = createHash('sha256').update(layer2).digest('hex');
  await writeFile(
    path.join(OUT, 'docker-save.tar'),
    rawTar([
      {
        path: 'manifest.json',
        data: json([
          {
            Config: 'config.json',
            Layers: ['layer1/layer.tar', `blobs/sha256/${layer2Digest}`],
          },
        ]),
      },
      { path: 'config.json', data: '{}\n' },
      { path: 'layer1/layer.tar', data: layer1 },
      { path: `blobs/sha256/${layer2Digest}`, data: layer2 },
    ]),
  );

  // 5. app-ioc.tgz + scan-ioc-test.json — a vendored package whose payload
  //    file's sha256 is recorded as a fileIocs entry in a local incident
  //    bundle (loaded in tests via LOCKWARDEN_INCIDENT_DIR).
  const payload = `${INERT_MARKER}// lockwarden scan file-IOC fixture payload — inert\n`;
  const payloadSha = createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex');
  await writeFile(
    path.join(OUT, 'app-ioc.tgz'),
    writeTarGz([
      {
        path: 'package.json',
        data: json({ name: 'app-ioc', version: '1.0.0', private: true, main: 'index.js' }),
      },
      { path: 'index.js', data: INERT_JS },
      {
        path: 'node_modules/iocpkg/package.json',
        data: json({ name: 'iocpkg', version: '1.0.0', main: 'index.js' }),
      },
      { path: 'node_modules/iocpkg/index.js', data: INERT_JS },
      { path: 'node_modules/iocpkg/payload.js', data: payload },
    ]),
  );
  await writeFile(
    path.join(FIXTURES, 'incidents', 'scan-ioc-test.json'),
    json({
      id: 'scan-ioc-test',
      name: 'Scan file-IOC test bundle (never shipped)',
      date: '2026-01-01',
      summary: 'Local-only bundle exercising scan fileIocs sha256 matching.',
      packages: [],
      fileIocs: [{ path: 'payload.js', sha256: payloadSha }],
    }),
  );

  console.log(`scan fixtures written under ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error('build-scan-fixtures failed:', err);
  process.exit(1);
});
