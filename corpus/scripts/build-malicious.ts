import type { Buffer } from 'node:buffer';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackageEntries } from '../src/artifact.ts';
import {
  type MutationKind,
  applyMutation,
  bumpVersion,
  patchBumpVersion,
  toWriteEntries,
} from '../src/mutations.ts';
import { writeTarGz } from '../src/tar-write.ts';

/**
 * Build the synthetic malicious corpus from cached benign CURRENT tarballs.
 * Every payload is DEFANGED. Output:
 *   corpus/generated/malicious/<id>/{previous.tgz,malicious.tgz}
 *   corpus/generated/lockfile-pairs/<id>/{base.json,patched.json}  (transitive)
 *
 * Run: node --experimental-strip-types scripts/build-malicious.ts
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CACHE = path.join(ROOT, 'cache');
const OUT_MAL = path.join(ROOT, 'generated', 'malicious');
const OUT_LOCK = path.join(ROOT, 'generated', 'lockfile-pairs');

interface Spec {
  id: string;
  base: string;
  mutation: MutationKind | 'add-transitive-in-patch';
  modeledOn: string;
}

function sanitize(name: string): string {
  return name.replace(/[/@]/g, '_');
}

function baseVersionOf(entries: Awaited<ReturnType<typeof readPackageEntries>>): string {
  const manifest = entries.find((e) => e.path === 'package.json');
  if (manifest === undefined) return '0.0.0';
  try {
    const parsed = JSON.parse(manifest.data.toString('utf8'));
    if (typeof parsed?.version === 'string') return parsed.version;
  } catch {
    /* ignore */
  }
  return '0.0.0';
}

/** Minimal npm v3 lockfile with a root + one dependency package. */
function lockfile(
  rootName: string,
  parent: string,
  parentVersion: string,
  extra?: { name: string; version: string },
): unknown {
  const packages: Record<string, unknown> = {
    '': { name: rootName, version: '1.0.0', dependencies: { [parent]: `^${parentVersion}` } },
    [`node_modules/${parent}`]: { version: parentVersion },
  };
  if (extra !== undefined) {
    (packages[`node_modules/${parent}`] as Record<string, unknown>).dependencies = {
      [extra.name]: `^${extra.version}`,
    };
    packages[`node_modules/${extra.name}`] = { version: extra.version };
  }
  return { name: rootName, lockfileVersion: 3, requires: true, packages };
}

async function buildTarballSpec(spec: Spec, mutation: MutationKind): Promise<string> {
  const currentPath = path.join(CACHE, sanitize(spec.base), 'current.tgz');
  let raw: Buffer;
  try {
    raw = await readFile(currentPath);
  } catch {
    return `SKIP ${spec.id}: cached tarball missing (${path.relative(ROOT, currentPath)}) — run \`pnpm fetch\` first`;
  }
  const entries = await readPackageEntries(raw);
  const previous = toWriteEntries(entries);
  const mutated = bumpVersion(applyMutation(entries, mutation));

  const dir = path.join(OUT_MAL, spec.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'previous.tgz'), writeTarGz(previous));
  await writeFile(path.join(dir, 'malicious.tgz'), writeTarGz(toWriteEntries(mutated)));
  return `OK   ${spec.id}: ${spec.mutation} on ${spec.base}`;
}

async function buildLockfileSpec(spec: Spec): Promise<string> {
  const currentPath = path.join(CACHE, sanitize(spec.base), 'current.tgz');
  let baseVersion = '1.0.0';
  try {
    baseVersion = baseVersionOf(await readPackageEntries(await readFile(currentPath)));
  } catch {
    // fine — use a placeholder version; the analyzer only needs the diff shape
  }
  const patched = patchBumpVersion(baseVersion);
  const dir = path.join(OUT_LOCK, spec.id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'base.json'),
    `${JSON.stringify(lockfile('demo-app', spec.base, baseVersion), null, 2)}\n`,
  );
  await writeFile(
    path.join(dir, 'patched.json'),
    `${JSON.stringify(
      lockfile('demo-app', spec.base, patched, { name: 'lw-phantom-dep', version: '1.0.0' }),
      null,
      2,
    )}\n`,
  );
  return `OK   ${spec.id}: add-transitive-in-patch on ${spec.base} (${baseVersion} -> ${patched})`;
}

async function main(): Promise<void> {
  const manifestPath = path.join(ROOT, 'manifest', 'malicious-synthetic.json');
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  const specs: Spec[] = parsed.specs;

  const results: string[] = [];
  for (const spec of specs) {
    if (spec.mutation === 'add-transitive-in-patch') {
      results.push(await buildLockfileSpec(spec));
    } else {
      results.push(await buildTarballSpec(spec, spec.mutation));
    }
  }

  for (const line of results) console.log(line);
  const ok = results.filter((r) => r.startsWith('OK')).length;
  const skip = results.filter((r) => r.startsWith('SKIP')).length;
  console.log(`\nbuild-malicious: ${ok} built, ${skip} skipped, ${specs.length} total`);
  if (skip > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('build-malicious failed:', err);
  process.exit(1);
});
