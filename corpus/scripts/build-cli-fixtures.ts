import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INERT_MARKER, inflatedMainSource } from '../src/mutations.ts';
import { type TarWriteEntry, writeTarGz } from '../src/tar-write.ts';

/**
 * Generate tiny (<3KB each) INERT committed CLI fixtures used by the tar.ts
 * and artifact.ts unit tests. These are NOT real packages — synthetic minis
 * that exercise the readers and each analyzer's benign/previous/malicious
 * shape. Regenerate with:
 *   node --experimental-strip-types corpus/scripts/build-cli-fixtures.ts
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', '..', 'packages', 'cli', 'test', 'fixtures', 'tarballs');

function manifest(fields: Record<string, unknown>): TarWriteEntry {
  return { path: 'package.json', data: `${JSON.stringify(fields, null, 2)}\n` };
}

async function emit(dir: string, file: string, entries: TarWriteEntry[]): Promise<void> {
  const target = path.join(OUT, dir);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, file), writeTarGz(entries));
}

async function main(): Promise<void> {
  // lifecycle-scripts
  await emit('lifecycle-scripts', 'benign.tgz', [
    manifest({ name: 'lc-mini', version: '1.0.0', main: 'index.js' }),
    { path: 'index.js', data: `${INERT_MARKER}module.exports = 1;\n` },
  ]);
  await emit('lifecycle-scripts', 'previous.tgz', [
    manifest({ name: 'lc-mini', version: '1.0.0', main: 'index.js' }),
    { path: 'index.js', data: `${INERT_MARKER}module.exports = 1;\n` },
  ]);
  await emit('lifecycle-scripts', 'malicious.tgz', [
    manifest({
      name: 'lc-mini',
      version: '1.0.1',
      main: 'index.js',
      scripts: { postinstall: 'node lw-inert.js' },
    }),
    { path: 'index.js', data: `${INERT_MARKER}module.exports = 1;\n` },
    { path: 'lw-inert.js', data: INERT_MARKER },
  ]);

  // binding-gyp
  const gypBenign: TarWriteEntry[] = [
    manifest({ name: 'gyp-mini', version: '1.0.0', main: 'index.js' }),
    { path: 'index.js', data: `${INERT_MARKER}module.exports = 1;\n` },
  ];
  await emit('binding-gyp', 'benign.tgz', gypBenign);
  await emit('binding-gyp', 'previous.tgz', gypBenign);
  await emit('binding-gyp', 'malicious.tgz', [
    manifest({ name: 'gyp-mini', version: '1.0.1', main: 'index.js', gypfile: true }),
    { path: 'index.js', data: `${INERT_MARKER}module.exports = 1;\n` },
    {
      path: 'binding.gyp',
      data: `${INERT_MARKER}{ "targets": [ { "target_name": "lw_inert", "sources": [] } ] }\n`,
    },
  ]);

  // agent-hooks
  const agentBenign: TarWriteEntry[] = [
    manifest({ name: 'agent-mini', version: '1.0.0', main: 'index.js' }),
    { path: 'index.js', data: `${INERT_MARKER}module.exports = 1;\n` },
  ];
  await emit('agent-hooks', 'benign.tgz', agentBenign);
  await emit('agent-hooks', 'previous.tgz', agentBenign);
  await emit('agent-hooks', 'malicious.tgz', [
    manifest({ name: 'agent-mini', version: '1.0.1', main: 'index.js' }),
    { path: 'index.js', data: `${INERT_MARKER}module.exports = 1;\n` },
    {
      path: '.claude/settings.json',
      data: `${JSON.stringify({ hooks: { SessionStart: [{ command: 'node lw-inert.js' }] } }, null, 2)}\n`,
    },
    {
      path: 'mcp.json',
      data: `${JSON.stringify({ mcpServers: { 'lw-inert': { command: 'node' } } }, null, 2)}\n`,
    },
  ]);

  // ide-tasks
  const ideBenign: TarWriteEntry[] = [
    manifest({ name: 'ide-mini', version: '1.0.0', main: 'index.js' }),
    { path: 'index.js', data: `${INERT_MARKER}module.exports = 1;\n` },
  ];
  await emit('ide-tasks', 'benign.tgz', ideBenign);
  await emit('ide-tasks', 'previous.tgz', ideBenign);
  await emit('ide-tasks', 'malicious.tgz', [
    manifest({ name: 'ide-mini', version: '1.0.1', main: 'index.js' }),
    { path: 'index.js', data: `${INERT_MARKER}module.exports = 1;\n` },
    {
      path: '.vscode/tasks.json',
      data: `${JSON.stringify(
        {
          version: '2.0.0',
          tasks: [{ label: 'x', command: 'node lw-inert.js', runOptions: { runOn: 'folderOpen' } }],
        },
        null,
        2,
      )}\n`,
    },
  ]);

  // size-delta
  await emit('size-delta', 'benign.tgz', [
    manifest({ name: 'size-mini', version: '1.0.1', main: 'index.js' }),
    { path: 'index.js', data: `${INERT_MARKER}module.exports = 1;\n` },
  ]);
  await emit('size-delta', 'previous.tgz', [
    manifest({ name: 'size-mini', version: '1.0.0', main: 'index.js' }),
    { path: 'index.js', data: `${INERT_MARKER}module.exports = 1;\n` },
  ]);
  await emit('size-delta', 'malicious.tgz', [
    manifest({ name: 'size-mini', version: '1.0.1', main: 'index.js' }),
    { path: 'index.js', data: inflatedMainSource(2500) },
  ]);

  // obfuscation
  const obfBenign: TarWriteEntry[] = [
    manifest({
      name: 'obf-mini',
      version: '1.0.0',
      main: 'index.js',
      scripts: { postinstall: 'node install.js' },
    }),
    { path: 'index.js', data: `${INERT_MARKER}module.exports = 1;\n` },
    { path: 'install.js', data: `${INERT_MARKER}// nothing to see\n` },
  ];
  await emit('obfuscation', 'benign.tgz', obfBenign);
  await emit('obfuscation', 'previous.tgz', obfBenign);
  await emit('obfuscation', 'malicious.tgz', [
    manifest({
      name: 'obf-mini',
      version: '1.0.1',
      main: 'index.js',
      scripts: { postinstall: 'node install.js' },
    }),
    { path: 'index.js', data: `${INERT_MARKER}module.exports = 1;\n` },
    { path: 'install.js', data: inflatedMainSource(2500) },
  ]);

  // phantom-deps
  await emit('phantom-deps', 'benign.tgz', [
    manifest({
      name: 'phantom-mini',
      version: '1.0.0',
      main: 'index.js',
      dependencies: { ms: '^2.0.0' },
    }),
    { path: 'index.js', data: `${INERT_MARKER}const ms = require('ms');\nmodule.exports = ms;\n` },
  ]);
  await emit('phantom-deps', 'previous.tgz', [
    manifest({
      name: 'phantom-mini',
      version: '1.0.0',
      main: 'index.js',
      dependencies: { ms: '^2.0.0' },
    }),
    { path: 'index.js', data: `${INERT_MARKER}const ms = require('ms');\nmodule.exports = ms;\n` },
  ]);
  await emit('phantom-deps', 'malicious.tgz', [
    manifest({
      name: 'phantom-mini',
      version: '1.0.1',
      main: 'index.js',
      dependencies: { ms: '^2.0.0', 'lw-phantom-dep': '^1.0.0' },
    }),
    { path: 'index.js', data: `${INERT_MARKER}const ms = require('ms');\nmodule.exports = ms;\n` },
  ]);

  // native-binary
  const nativeBenign: TarWriteEntry[] = [
    manifest({ name: 'native-mini', version: '1.0.0', main: 'index.js' }),
    { path: 'index.js', data: `${INERT_MARKER}module.exports = 1;\n` },
  ];
  await emit('native-binary', 'benign.tgz', nativeBenign);
  await emit('native-binary', 'previous.tgz', nativeBenign);
  await emit('native-binary', 'malicious.tgz', [
    manifest({
      name: 'native-mini',
      version: '1.0.1',
      main: 'index.js',
      dependencies: { 'prebuild-install': '^7.1.0' },
    }),
    { path: 'index.js', data: `${INERT_MARKER}module.exports = 1;\n` },
    { path: 'build/Release/lw_inert.node', data: INERT_MARKER },
  ]);

  // dep-introduction (tree-level): committed as a loadable placeholder set so
  // the fixture layout is uniform; the real calibration uses lockfile pairs.
  const depMini: TarWriteEntry[] = [
    manifest({ name: 'dep-mini', version: '1.0.0', main: 'index.js' }),
    { path: 'index.js', data: `${INERT_MARKER}module.exports = 1;\n` },
  ];
  await emit('dep-introduction', 'benign.tgz', depMini);
  await emit('dep-introduction', 'previous.tgz', depMini);
  await emit('dep-introduction', 'malicious.tgz', depMini);

  // PAX long-path fixture: a file whose package/<path> exceeds 100 bytes,
  // forcing a PAX extended header — exercises readTarGz PAX handling.
  const longName = `deeply/nested/${'segment-'.repeat(12)}leaf.js`;
  await emit('_readers', 'pax-longpath.tgz', [
    manifest({ name: 'pax-mini', version: '1.0.0' }),
    { path: longName, data: `${INERT_MARKER}module.exports = 'long';\n` },
  ]);

  console.log(`CLI fixtures written under ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error('build-cli-fixtures failed:', err);
  process.exit(1);
});
