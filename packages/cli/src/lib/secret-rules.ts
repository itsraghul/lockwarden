import type { Severity } from '../scoring/weights.js';

/**
 * Curated secret-pattern table for `lockwarden secrets`. Deliberately minimal
 * (spec §2.5): ~15 high-signal patterns + one entropy heuristic. Table-stakes
 * convenience, never the differentiator — precision over recall, no
 * user-configurable rule packs.
 *
 * Findings NEVER carry the raw secret: every rule masks its match down to
 * first-4 + last-2 characters before it leaves this module.
 */

export interface SecretRule {
  id: string;
  name: string;
  severity: Severity;
  /** Applied per line; must carry the `g` flag (matchAll). */
  regex: RegExp;
  /** Reduces the matched secret to a safe excerpt. */
  mask: (secret: string) => string;
  /** File-level precondition (e.g. both GCP key-file markers present). */
  fileRequires?: RegExp;
  /** Post-match check (entropy, decodability). Match survives when true. */
  validate?: (match: RegExpMatchArray) => boolean;
}

export interface SecretMatch {
  ruleId: string;
  ruleName: string;
  severity: Severity;
  /** 1-based line number. */
  line: number;
  /** Masked — safe to print anywhere, including --json. */
  excerpt: string;
}

/** Shannon entropy of a string in bits per character. Empty string → 0. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** First 4 + last 2 characters; everything between is elided. */
export function maskSecret(secret: string): string {
  if (secret.length <= 6) return '…';
  return `${secret.slice(0, 4)}…${secret.slice(-2)}`;
}

/** Entropy floor for the generic credential-assignment heuristic. */
export const GENERIC_ENTROPY_MIN = 4.0;

function base64UrlJson(segment: string): boolean {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'aws-access-key',
    name: 'AWS access key ID',
    severity: 'high',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    mask: maskSecret,
  },
  {
    id: 'aws-secret-key',
    name: 'AWS secret access key',
    severity: 'high',
    regex: /aws.{0,20}['"]([0-9a-zA-Z/+]{40})['"]/gi,
    mask: maskSecret,
  },
  {
    id: 'github-token',
    name: 'GitHub token',
    severity: 'high',
    regex: /\b(?:gh[pos]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{36,})\b/g,
    mask: maskSecret,
  },
  {
    id: 'npm-token',
    name: 'npm access token',
    severity: 'high',
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
    mask: maskSecret,
  },
  {
    id: 'slack-token',
    name: 'Slack token',
    severity: 'med',
    regex: /\bxox[bpars]-[A-Za-z0-9-]{10,}/g,
    mask: maskSecret,
  },
  {
    id: 'stripe-live-key',
    name: 'Stripe live secret key',
    severity: 'high',
    regex: /\bsk_live_[A-Za-z0-9]{16,}\b/g,
    mask: maskSecret,
  },
  {
    id: 'stripe-test-key',
    name: 'Stripe test secret key',
    severity: 'low',
    regex: /\bsk_test_[A-Za-z0-9]{16,}\b/g,
    mask: maskSecret,
  },
  {
    id: 'google-api-key',
    name: 'Google API key',
    severity: 'med',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    mask: maskSecret,
  },
  {
    // "private_key_id" alone is just a field name; the pair of markers is the
    // GCP service-account key-file shape. fileRequires cannot false-positive
    // on "private_key_id" itself: the closing quote position differs.
    id: 'gcp-service-account',
    name: 'GCP service account key file',
    severity: 'high',
    regex: /"private_key_id"/g,
    fileRequires: /"private_key"/,
    mask: maskSecret,
  },
  {
    id: 'private-key-pem',
    name: 'Private key (PEM)',
    severity: 'high',
    regex: /-----BEGIN (?:RSA|EC|OPENSSH|PGP)? ?PRIVATE KEY-----/g,
    mask: maskSecret,
  },
  {
    id: 'azure-account-key',
    name: 'Azure storage AccountKey',
    severity: 'med',
    regex: /AccountKey=([A-Za-z0-9+/=]{20,})/g,
    mask: maskSecret,
  },
  {
    id: 'twilio-api-key',
    name: 'Twilio API key SID',
    severity: 'med',
    regex: /\bSK[0-9a-f]{32}\b/g,
    mask: maskSecret,
  },
  {
    id: 'sendgrid-api-key',
    name: 'SendGrid API key',
    severity: 'med',
    regex: /\bSG\.[A-Za-z0-9_-]{22}\./g,
    mask: maskSecret,
  },
  {
    id: 'jwt',
    name: 'JSON Web Token',
    severity: 'low',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    mask: maskSecret,
    validate: (m) => {
      const [header, payload] = m[0].split('.');
      return (
        header !== undefined &&
        payload !== undefined &&
        base64UrlJson(header) &&
        base64UrlJson(payload)
      );
    },
  },
  {
    id: 'generic-high-entropy',
    name: 'High-entropy credential assignment',
    severity: 'med',
    regex: /(?:secret|token|password|api_?key)\s*[:=]\s*['"]([^'"\s]{20,})['"]/gi,
    mask: maskSecret,
    validate: (m) => m[1] !== undefined && shannonEntropy(m[1]) > GENERIC_ENTROPY_MIN,
  },
];

/** The secret itself: the innermost capture when present, else the whole match. */
function secretOf(match: RegExpMatchArray): string {
  return match[1] ?? match[0];
}

/**
 * Scan one file's text content against every rule. Line-oriented; returns
 * masked matches only. Pure — file walking and attribution live in the
 * `secrets` command.
 */
export function scanContent(content: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  const lines = content.split(/\r?\n/);
  for (const rule of SECRET_RULES) {
    if (rule.fileRequires && !rule.fileRequires.test(content)) continue;
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      if (lineText === undefined) continue;
      for (const match of lineText.matchAll(rule.regex)) {
        if (rule.validate && !rule.validate(match)) continue;
        matches.push({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          line: i + 1,
          excerpt: rule.mask(secretOf(match)),
        });
      }
    }
  }
  return matches;
}
