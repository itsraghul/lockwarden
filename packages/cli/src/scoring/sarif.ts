/**
 * SARIF 2.1.0 mapper. Severity → level: critical→error, high→warning,
 * med→note; low is suppressed unless opts.verbose; 'none' never appears
 * (the engine already drops none-weighted signals).
 */
import { createHash } from 'node:crypto';
import type { AuditReport, Finding, PackageReport } from './types.ts';
import type { Severity } from './weights.ts';

const REPO_URL = 'https://github.com/itsraghul/lockwarden';
const HELP_URI = `${REPO_URL}#readme`;

const SARIF_LEVEL: Partial<Record<Severity, 'error' | 'warning' | 'note'>> = {
  critical: 'error',
  high: 'warning',
  med: 'note',
  low: 'note', // emitted only with opts.verbose
};

export interface SarifOptions {
  /** Include low-severity findings (suppressed by default). */
  verbose?: boolean;
  /** Real CLI version, injected by the command. */
  toolVersion?: string;
}

function codeOf(finding: Finding): string {
  return finding.layer === 1 ? finding.signal.code : finding.code;
}

function messageOf(pkg: PackageReport, finding: Finding): string {
  const detail = finding.layer === 1 ? finding.signal.evidence.detail : finding.layer2.summary;
  return `${pkg.key}: ${detail}`;
}

/** Stable result identity across runs: sha256 of "code:name@version". */
function fingerprintOf(pkg: PackageReport, code: string): string {
  return createHash('sha256').update(`${code}:${pkg.key}`).digest('hex');
}

export function toSarif(report: AuditReport, opts: SarifOptions = {}): object {
  const rules: Array<{ id: string; helpUri: string }> = [];
  const ruleIndexByCode = new Map<string, number>();
  const results: object[] = [];

  for (const pkg of report.packages) {
    for (const finding of pkg.findings) {
      if (finding.severity === 'low' && !opts.verbose) continue;
      const level = SARIF_LEVEL[finding.severity];
      if (level === undefined) continue; // 'none' never appears

      const code = codeOf(finding);
      let ruleIndex = ruleIndexByCode.get(code);
      if (ruleIndex === undefined) {
        ruleIndex = rules.length;
        ruleIndexByCode.set(code, ruleIndex);
        rules.push({ id: code, helpUri: HELP_URI });
      }

      results.push({
        ruleId: code,
        ruleIndex,
        level,
        message: { text: messageOf(pkg, finding) },
        locations: [
          {
            physicalLocation: {
              // repo-relative, exactly as the command passed it
              artifactLocation: { uri: report.lockfile.path },
            },
            logicalLocations: [{ fullyQualifiedName: pkg.key }],
          },
        ],
        partialFingerprints: { 'lockwarden/v1': fingerprintOf(pkg, code) },
      });
    }
  }

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'lockwarden',
            informationUri: REPO_URL,
            version: opts.toolVersion ?? '0.0.0',
            rules,
          },
        },
        results,
      },
    ],
  };
}
