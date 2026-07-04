import { describe, expect, it } from 'vitest';
import {
  GENERIC_ENTROPY_MIN,
  SECRET_RULES,
  maskSecret,
  scanContent,
  shannonEntropy,
} from '../../../src/lib/secret-rules.js';

/**
 * Secret-shaped tokens are assembled at RUNTIME (join/concat) so the
 * committed source never contains a contiguous provider-shaped literal —
 * GitHub push protection rejects those. Two officially-documented examples
 * stay literal: AWS's AKIAIOSFODNN7EXAMPLE and the jwt.io example JWT.
 */
const GHP = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const GITHUB_PAT = ['github', 'pat', 'a'.repeat(60)].join('_');
const NPM_TOKEN = ['npm', 'a1'.repeat(18)].join('_');
const SK_LIVE = ['sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc'].join('_');
const SK_TEST = ['sk', 'test', '4eC39HqLyjWDarjtT1zdp7dc'].join('_');
const XOXB = ['xoxb', '123456789012', 'abcdefghij'].join('-');
const AWS_SECRET = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/');
const SENDGRID = ['SG', 'a1B2c3d4e5F6g7h8i9J0k1', 'rest'].join('.');

/** Rule ids fired by a single-line scan. */
function firedRules(content: string): string[] {
  return scanContent(content).map((m) => m.ruleId);
}

describe('shannonEntropy', () => {
  it('is 0 for empty and single-symbol strings', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
  });

  it('is log2(n) for n equally frequent symbols', () => {
    expect(shannonEntropy('abcd')).toBeCloseTo(2);
    expect(shannonEntropy('abcdefghabcdefgh')).toBeCloseTo(3);
  });

  it('grows with symbol diversity', () => {
    expect(shannonEntropy('abababab')).toBeLessThan(shannonEntropy('abcdefgh'));
  });
});

describe('maskSecret', () => {
  it('keeps only the first 4 and last 2 characters', () => {
    expect(maskSecret('AKIAIOSFODNN7EXAMPLE')).toBe('AKIA…LE');
  });

  it('fully elides short strings', () => {
    expect(maskSecret('abcdef')).toBe('…');
  });

  it('never contains the original secret', () => {
    expect(maskSecret(GHP)).not.toContain(GHP);
    expect(maskSecret(GHP).length).toBeLessThan(GHP.length);
  });
});

describe('rule table', () => {
  it('has ~15 curated rules, all with global-flag regexes', () => {
    expect(SECRET_RULES.length).toBe(15);
    for (const rule of SECRET_RULES) {
      expect(rule.regex.global, `${rule.id} needs the g flag for matchAll`).toBe(true);
    }
  });

  it('aws-access-key fires on AKIA + 16, not on a too-short key', () => {
    expect(firedRules("const k = 'AKIAIOSFODNN7EXAMPLE';")).toContain('aws-access-key');
    expect(firedRules("const k = 'AKIAIOSFODN7EXAMP';")).not.toContain('aws-access-key');
  });

  it('aws-secret-key fires on a 40-char value near an aws mention only', () => {
    expect(firedRules(`aws_secret = "${AWS_SECRET}"`)).toContain('aws-secret-key');
    expect(firedRules(`other_secret = "${AWS_SECRET.slice(0, 39)}"`)).not.toContain(
      'aws-secret-key',
    );
  });

  it('github-token fires on ghp_/github_pat_, not on a truncated token', () => {
    expect(firedRules(GHP)).toContain('github-token');
    expect(firedRules(GITHUB_PAT)).toContain('github-token');
    expect(firedRules('ghp_tooshort123')).not.toContain('github-token');
  });

  it('npm-token requires exactly npm_ + 36 alphanumerics', () => {
    expect(firedRules(NPM_TOKEN)).toContain('npm-token');
    expect(firedRules(`${NPM_TOKEN.slice(0, -1)} end`)).not.toContain('npm-token');
  });

  it('slack-token fires on xox[bpars]- prefixes only', () => {
    expect(firedRules(XOXB)).toContain('slack-token');
    expect(firedRules('xoxq-123456789012-abcdefghij')).not.toContain('slack-token');
  });

  it('stripe live key does not fire inside a longer word', () => {
    expect(firedRules(`key: '${SK_LIVE}'`)).toContain('stripe-live-key');
    expect(firedRules(`key: 'x${SK_LIVE}'`)).not.toContain('stripe-live-key');
  });

  it('stripe test key is a low-severity finding', () => {
    const matches = scanContent(`const k = '${SK_TEST}';`);
    expect(matches.map((m) => m.ruleId)).toContain('stripe-test-key');
    expect(matches.find((m) => m.ruleId === 'stripe-test-key')?.severity).toBe('low');
  });

  it('google-api-key needs AIza + exactly 35 more chars', () => {
    expect(firedRules(`AIza${'Sy0-_abc'.repeat(5)}abc`)).toContain('google-api-key');
    expect(firedRules('AIzaShort')).not.toContain('google-api-key');
  });

  it('gcp-service-account needs BOTH key-file markers in the same file', () => {
    const both = '{"private_key_id": "abc", "private_key": "-"}';
    expect(firedRules(both)).toContain('gcp-service-account');
    // "private_key_id" alone must not satisfy the "private_key" precondition
    expect(firedRules('{"private_key_id": "abc"}')).not.toContain('gcp-service-account');
  });

  it('private-key-pem fires on PEM private headers, not public keys', () => {
    expect(firedRules('-----BEGIN RSA PRIVATE KEY-----')).toContain('private-key-pem');
    expect(firedRules('-----BEGIN PRIVATE KEY-----')).toContain('private-key-pem');
    expect(firedRules('-----BEGIN OPENSSH PRIVATE KEY-----')).toContain('private-key-pem');
    expect(firedRules('-----BEGIN PUBLIC KEY-----')).not.toContain('private-key-pem');
  });

  it('azure-account-key requires 20+ base64 chars after AccountKey=', () => {
    expect(firedRules(`AccountKey=${'Ab0+/'.repeat(5)}==;`)).toContain('azure-account-key');
    expect(firedRules('AccountKey=short==')).not.toContain('azure-account-key');
  });

  it('twilio-api-key requires SK + 32 lowercase hex', () => {
    expect(firedRules(`SK${'0123456789abcdef'.repeat(2)}`)).toContain('twilio-api-key');
    expect(firedRules(`SK${'0123456789ABCDEF'.repeat(2)}`)).not.toContain('twilio-api-key');
  });

  it('sendgrid-api-key matches the SG.<22>. shape', () => {
    expect(firedRules(SENDGRID)).toContain('sendgrid-api-key');
    expect(firedRules('SG.short.rest')).not.toContain('sendgrid-api-key');
  });

  it('jwt fires only when header and payload decode to JSON', () => {
    const real =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(firedRules(`Bearer ${real}`)).toContain('jwt');
    // right shape, but the segments are not base64url-encoded JSON
    expect(firedRules('eyJzzzzzzzzzzzz.eyJzzzzzzzzzzzz.zzzzzzzzzzzz')).not.toContain('jwt');
  });

  it('generic-high-entropy gates on Shannon entropy of the captured value', () => {
    const random = 'kJ8xQ2mZp7Rw4Vt6Ys1Bn3Ld5Fg0Hc';
    expect(shannonEntropy(random)).toBeGreaterThan(GENERIC_ENTROPY_MIN);
    expect(firedRules(`const apiKey = '${random}';`)).toContain('generic-high-entropy');
    expect(firedRules(`password = "${'a'.repeat(24)}"`)).not.toContain('generic-high-entropy');
    expect(firedRules("const apiKey = 'short';")).not.toContain('generic-high-entropy');
  });
});

describe('scanContent', () => {
  it('reports 1-based line numbers', () => {
    const matches = scanContent("line one\nline two\nkey = 'AKIAIOSFODNN7EXAMPLE'\n");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.line).toBe(3);
  });

  it('never emits the raw secret, only the masked excerpt', () => {
    const secrets = ['AKIAIOSFODNN7EXAMPLE', GHP, SK_LIVE, 'kJ8xQ2mZp7Rw4Vt6Ys1Bn3Ld5Fg0Hc'];
    const content = secrets.map((s) => `const apiKey = '${s}';`).join('\n');
    const serialized = JSON.stringify(scanContent(content));
    expect(scanContent(content).length).toBeGreaterThanOrEqual(secrets.length);
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
  });
});
