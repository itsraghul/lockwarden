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
  maxAdvisoryAge?: string;
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
    .option('--offline', 'hard-fail any network call (exit 2)', false)
    .option(
      '--max-advisory-age <days>',
      'exit 2 when the vendored advisory data is older than <days> days',
    );

  program
    .command('audit')
    .description('execution-surface audit of the resolved dependency tree')
    .option(
      '--diff <base-ref>',
      'delta-score only packages whose resolved version changed vs a git ref',
    )
    .option('--deep', 'full-tree delta scan (fetches previous version of every dep — slow)', false)
    .option('--verbose', 'include Low findings in SARIF output', false)
    .option('--baseline <path>', 'baseline file (default: <dir>/.lockwarden-baseline.json)')
    .option('--no-baseline', 'ignore any baseline file')
    .option('--write-baseline', 'create/update the baseline from current findings', false)
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

  program
    .command('explain')
    .description('explain a finding code: what it detects, its weights, what to do')
    .argument('[code]', 'e.g. LW001, LW001-LIFECYCLE, lifecycle-scripts, LW2-OSV; omit to list all')
    .action(async (code: string | undefined, _options, command: Command) => {
      const { runExplain } = await import('./commands/explain.js');
      process.exitCode = await runExplain(code, command.optsWithGlobals());
    });

  program
    .command('incidents')
    .description('list the incident bundles this build knows (for check --incident <id>)')
    .action(async (_options, command: Command) => {
      const { runIncidents } = await import('./commands/incidents.js');
      process.exitCode = await runIncidents(command.optsWithGlobals());
    });

  program
    .command('drift')
    .description('lockfile & version-anomaly detection vs a base ref')
    .option('--base <ref>', 'git ref to compare the lockfile against', 'main')
    .action(async (options, command: Command) => {
      const { runDrift } = await import('./commands/drift.js');
      process.exitCode = await runDrift(options, command.optsWithGlobals());
    });

  program
    .command('scan')
    .description('execution-surface scan of an artifact: tarball, zip, dir, or docker-save image')
    .argument('[artifact]', 'path to a tarball/zip/directory artifact')
    .option('--image <docker-image>', 'scan a docker image (via docker save)')
    .option('--verbose', 'include Low findings in SARIF output', false)
    .option('--baseline <path>', 'baseline file (default: <dir>/.lockwarden-baseline.json)')
    .option('--no-baseline', 'ignore any baseline file')
    .option('--write-baseline', 'create/update the baseline from current findings', false)
    .action(async (artifact: string | undefined, options, command: Command) => {
      const { runScan } = await import('./commands/scan.js');
      process.exitCode = await runScan(artifact, options, command.optsWithGlobals());
    });

  program
    .command('secrets')
    .description('minimal hardcoded-secret scan of the project and dependency install paths')
    .action(async (_options, command: Command) => {
      const { runSecrets } = await import('./commands/secrets.js');
      process.exitCode = await runSecrets(command.optsWithGlobals());
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
