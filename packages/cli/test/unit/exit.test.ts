import { describe, expect, it } from 'vitest';
import { ExecError, ExitCode, OfflineViolationError } from '../../src/exit.js';

describe('exit codes', () => {
  it('exposes the 0/1/2 API', () => {
    expect(ExitCode.Clean).toBe(0);
    expect(ExitCode.Findings).toBe(1);
    expect(ExitCode.Error).toBe(2);
  });

  it('ExecError carries exit code 2', () => {
    const err = new ExecError('boom', 'try again');
    expect(err.exitCode).toBe(2);
    expect(err.hint).toBe('try again');
  });

  it('OfflineViolationError names the attempted URL', () => {
    const err = new OfflineViolationError('https://registry.npmjs.org/foo');
    expect(err.exitCode).toBe(2);
    expect(err.message).toContain('registry.npmjs.org/foo');
    expect(err.message).toContain('--offline');
  });
});
