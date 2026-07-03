import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Integration tests spawn the built CLI (dist/index.js). Build it once per
 * test run so integration tests always exercise the real artifact.
 */
export default function setup(): void {
  const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync('pnpm', ['build'], { cwd: cliRoot, stdio: 'inherit' });
  const bundle = join(cliRoot, 'dist', 'index.js');
  if (!existsSync(bundle)) {
    throw new Error(`tsup build did not produce ${bundle}`);
  }
}
