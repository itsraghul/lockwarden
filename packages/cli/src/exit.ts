export const ExitCode = {
  Clean: 0,
  Findings: 1,
  Error: 2,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Any failure that must terminate with exit code 2 (parse error, offline
 * violation, git failure, bad arguments). Thrown anywhere, caught once in
 * index.ts. Exit codes are the API — never process.exit() elsewhere.
 */
export class ExecError extends Error {
  readonly exitCode = ExitCode.Error;

  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ExecError';
  }
}

export class OfflineViolationError extends ExecError {
  constructor(url: string) {
    super(
      `--offline is set but a network call to ${url} was attempted`,
      'Remove --offline, or avoid flags that require tarball fetches (--diff/--deep).',
    );
    this.name = 'OfflineViolationError';
  }
}
