import { ExecError } from '../exit.js';
import type { GlobalOptions } from '../index.js';

export interface CheckOptions {
  incident?: string;
  history?: boolean;
}

export async function runCheck(
  queries: string[],
  options: CheckOptions,
  globals: GlobalOptions,
): Promise<number> {
  // Implemented in Phase 3 — stub keeps the scaffold building end-to-end.
  void queries;
  void options;
  void globals;
  throw new ExecError('check is not implemented yet (scaffold phase)');
}
