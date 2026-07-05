import { Buffer } from 'node:buffer';
import type { RawEntry } from './artifact.ts';
import type { TarWriteEntry } from './tar-write.ts';

/**
 * Defanged synthetic mutations shared by build-malicious.ts (real-tarball
 * corpus) and build-cli-fixtures.ts (tiny committed CLI fixtures). Every
 * injected payload is inert — a comment, never executable malware.
 */

export const INERT_MARKER = '/* lockwarden synthetic corpus — inert */\n';

export type MutationKind =
  | 'inject-postinstall'
  | 'inject-binding-gyp'
  | 'inject-mcp-manifest'
  | 'inject-vscode-task'
  | 'inflate-main-25x'
  | 'add-phantom-dep'
  | 'inject-node-binary'
  | 'inject-prebuild-fetcher';

/** Bump the patch component of a semver-ish version; falls back to +".1". */
export function patchBumpVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version);
  if (m === null) return `${version}-lw.1`;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function readManifest(entries: RawEntry[]): {
  index: number;
  manifest: Record<string, unknown>;
} {
  const index = entries.findIndex((e) => e.path === 'package.json');
  if (index === -1) return { index: -1, manifest: {} };
  try {
    const parsed = JSON.parse((entries[index] as RawEntry).data.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { index, manifest: parsed as Record<string, unknown> };
    }
  } catch {
    // fall through
  }
  return { index, manifest: {} };
}

function writeManifest(
  entries: RawEntry[],
  index: number,
  manifest: Record<string, unknown>,
): void {
  const data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const patched: RawEntry = { path: 'package.json', size: data.length, data };
  if (index === -1) entries.push(patched);
  else entries[index] = patched;
}

function resolveMainPath(manifest: Record<string, unknown>, entries: RawEntry[]): string {
  const main = manifest.main;
  if (typeof main === 'string' && main !== '') {
    let p = main;
    while (p.startsWith('./')) p = p.slice(2);
    if (entries.some((e) => e.path === p)) return p;
    if (entries.some((e) => e.path === `${p}.js`)) return `${p}.js`;
  }
  if (entries.some((e) => e.path === 'index.js')) return 'index.js';
  return 'index.js';
}

/** Bump the manifest version (patch) — applied to every mutated artifact. */
export function bumpVersion(entries: RawEntry[]): RawEntry[] {
  const out = entries.slice();
  const { index, manifest } = readManifest(out);
  if (typeof manifest.version === 'string') {
    manifest.version = patchBumpVersion(manifest.version);
    writeManifest(out, index, manifest);
  }
  return out;
}

/** Generate an inert file that trips the obfuscation hex-array heuristic. */
export function inflatedMainSource(targetBytes: number): string {
  const parts: string[] = [INERT_MARKER, 'var _0x = ['];
  const members: string[] = [];
  let approx = 40;
  let i = 0;
  while (approx < targetBytes) {
    const hex = `0x${((i * 2654435761) & 0xffffff).toString(16)}`;
    members.push(hex);
    approx += hex.length + 1;
    i++;
  }
  parts.push(members.join(','));
  parts.push('];\n');
  parts.push('var _s = String.fromCharCode(0x6c,0x77,0x69,0x6e,0x65,0x72,0x74);\n');
  return parts.join('');
}

/** Apply a content mutation to a stripped entry list. Returns a NEW list. */
export function applyMutation(entries: RawEntry[], kind: MutationKind): RawEntry[] {
  const out = entries.slice();
  const { index, manifest } = readManifest(out);
  const push = (path: string, data: string | Buffer): void => {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const at = out.findIndex((e) => e.path === path);
    const entry: RawEntry = { path, size: buf.length, data: buf };
    if (at === -1) out.push(entry);
    else out[at] = entry;
  };

  switch (kind) {
    case 'inject-postinstall': {
      const scripts =
        manifest.scripts !== null && typeof manifest.scripts === 'object'
          ? (manifest.scripts as Record<string, unknown>)
          : {};
      scripts.postinstall = 'node lw-inert.js';
      manifest.scripts = scripts;
      push('lw-inert.js', INERT_MARKER);
      break;
    }
    case 'inject-binding-gyp': {
      manifest.gypfile = true;
      push(
        'binding.gyp',
        `${INERT_MARKER}{\n  "targets": [\n    { "target_name": "lw_inert", "sources": [] }\n  ]\n}\n`,
      );
      break;
    }
    case 'inject-mcp-manifest': {
      push(
        '.claude/settings.json',
        `${JSON.stringify(
          { hooks: { SessionStart: [{ command: 'node lw-inert.js' }] } },
          null,
          2,
        )}\n`,
      );
      push(
        'mcp.json',
        `${JSON.stringify({ mcpServers: { 'lw-inert': { command: 'node', args: ['lw-inert.js'] } } }, null, 2)}\n`,
      );
      push('lw-inert.js', INERT_MARKER);
      break;
    }
    case 'inject-vscode-task': {
      push(
        '.vscode/tasks.json',
        `${JSON.stringify(
          {
            version: '2.0.0',
            tasks: [
              {
                label: 'lw-inert',
                type: 'shell',
                command: 'node lw-inert.js',
                runOptions: { runOn: 'folderOpen' },
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      push('lw-inert.js', INERT_MARKER);
      break;
    }
    case 'inflate-main-25x': {
      const mainPath = resolveMainPath(manifest, out);
      const existing = out.find((e) => e.path === mainPath);
      const prevSize = existing?.size ?? 200;
      push(mainPath, inflatedMainSource(Math.max(prevSize * 25, 60_000)));
      break;
    }
    case 'inject-node-binary': {
      // Models a prebuilt-binary dropper: a .node file appears in a patch
      // release with no gyp surface and no lifecycle script — it executes at
      // require-time, invisible to LW001/LW002.
      push('build/Release/lw_inert.node', INERT_MARKER);
      break;
    }
    case 'inject-prebuild-fetcher': {
      // Models an install-time binary fetcher: prebuild-install appears in
      // deps plus an install script. Deliberately also trips lifecycle-scripts
      // and binding-gyp ("node-gyp rebuild" fallback) — the realistic compound.
      const deps =
        manifest.dependencies !== null && typeof manifest.dependencies === 'object'
          ? (manifest.dependencies as Record<string, unknown>)
          : {};
      deps['prebuild-install'] = '^7.1.0';
      manifest.dependencies = deps;
      const scripts =
        manifest.scripts !== null && typeof manifest.scripts === 'object'
          ? (manifest.scripts as Record<string, unknown>)
          : {};
      scripts.install = 'prebuild-install || node-gyp rebuild';
      manifest.scripts = scripts;
      break;
    }
    case 'add-phantom-dep': {
      // Models axios -> plain-crypto-js (Mar 2026): the payload package is
      // staged as a never-imported dependency AND activated by an install-
      // time dropper. Phantom-deps flags the staged dep; lifecycle-scripts
      // flags the dropper — the two corroborate, as in the real incident.
      const deps =
        manifest.dependencies !== null && typeof manifest.dependencies === 'object'
          ? (manifest.dependencies as Record<string, unknown>)
          : {};
      deps['lw-phantom-dep'] = '^1.0.0';
      manifest.dependencies = deps;
      const scripts =
        manifest.scripts !== null && typeof manifest.scripts === 'object'
          ? (manifest.scripts as Record<string, unknown>)
          : {};
      scripts.postinstall = 'node lw-inert.js';
      manifest.scripts = scripts;
      push('lw-inert.js', INERT_MARKER);
      break;
    }
  }

  writeManifest(out, index, manifest);
  return out;
}

/** Convert raw entries to writer entries (paths are package-relative). */
export function toWriteEntries(entries: RawEntry[]): TarWriteEntry[] {
  return entries.map((e) => ({ path: e.path, data: e.data }));
}
