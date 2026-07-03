import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExecError } from '../exit.js';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr).trim()
        : '';
    throw new ExecError(
      `git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`,
      'check --history and audit --diff need a git repository containing the lockfile',
    );
  }
}

export interface LockfileCommit {
  sha: string;
  date: string; // ISO 8601
}

/** Commits that touched the given file, newest first. */
export async function lockfileHistory(cwd: string, relPath: string): Promise<LockfileCommit[]> {
  const out = await git(['log', '--format=%H|%cI', '--', relPath], cwd);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', date = ''] = line.split('|');
      return { sha, date };
    });
}

/** File contents at a specific ref; null when the file does not exist at that ref. */
export async function showFileAt(
  cwd: string,
  ref: string,
  relPath: string,
): Promise<string | null> {
  try {
    return await git(['show', `${ref}:${relPath}`], cwd);
  } catch {
    return null;
  }
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
}
