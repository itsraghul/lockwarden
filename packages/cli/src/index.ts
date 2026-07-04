import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { ExecError, ExitCode } from './exit.js';

// Version is injected from package.json at build time by tsup (JSON inline).
import pkg from '../package.json' with { type: 'json' };

export interface GlobalOptions {
  json: boolean;
  sarif: boolean;
  ci: boolean;
  dir: string[];
  threshold: string;
  offline: boolean;
}

function buildProgram(): Command {
  const program = new Command();

  program
    .name('lockwarden')
    .description(
      'Audit what your npm dependency tree can execute — and answer "am I hit?" during supply-chain incidents.',
    )
    .version(pkg.version)
    .option('--json', 'machine-readable JSON output', false)
    .option('--sarif', 'SARIF 2.1.0 output (GitHub Security tab)', false)
    .option('--ci', 'no colour/spinner, exit codes only', false)
    .option(
      '--dir <path>',
      'monorepo package root(s), repeatable',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--threshold <grade>', 'minimum severity that triggers exit 1', 'high')
    .option('--offline', 'hard-fail any network call (exit 2)', false);

  program
    .command('audit')
    .description('execution-surface audit of the resolved dependency tree')
    .option(
      '--diff <base-ref>',
      'delta-score only packages whose resolved version changed vs a git ref',
    )
    .option('--deep', 'full-tree delta scan (fetches previous version of every dep — slow)', false)
    .option('--verbose', 'include Low findings in SARIF output', false)
    .action(async (options, command: Command) => {
      const { runAudit } = await import('./commands/audit.js');
      const exitCode = await runAudit(options, command.optsWithGlobals());
      process.exitCode = exitCode;
    });

  program
    .command('check')
    .description('incident triage: report every path by which a package enters the tree')
    .argument('[queries...]', 'package queries: <pkg>, <pkg>@<version>, <pkg>@<range>')
    .option('--incident <id>', 'check against a vendored incident IOC bundle')
    .option('--history', 'walk git history of the lockfile to report exposure windows')
    .action(async (queries: string[], options, command: Command) => {
      const { runCheck } = await import('./commands/check.js');
      const exitCode = await runCheck(queries, options, command.optsWithGlobals());
      process.exitCode = exitCode;
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  if (error instanceof ExecError) {
    console.error(`lockwarden: ${error.message}`);
    if (error.hint) console.error(`  hint: ${error.hint}`);
    process.exitCode = error.exitCode;
    return;
  }
  console.error('lockwarden: unexpected error');
  console.error(error);
  process.exitCode = ExitCode.Error;
});
