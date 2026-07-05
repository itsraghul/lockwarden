import { createHash } from 'node:crypto';
import type { Finding } from './types.ts';

/** The stable rule id of a finding: Layer-1 signal code or Layer-2 code. */
export function codeOf(finding: Finding): string {
  return finding.layer === 1 ? finding.signal.code : finding.code;
}

/** Stable SARIF result identity across runs: sha256 of "code:name@version". */
export function sarifFingerprint(code: string, key: string): string {
  return createHash('sha256').update(`${code}:${key}`).digest('hex');
}
