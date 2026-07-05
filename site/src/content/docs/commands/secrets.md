---
title: lockwarden secrets
description: Minimal hardcoded-secret scan of the project and dependency install paths — 15 rules, always masked, always offline. A convenience, not the differentiator.
---

Minimal hardcoded-secret scan of the project and dependency install paths.

## Synopsis

```bash
lockwarden secrets [--dir <path>]
```

```
Usage: lockwarden secrets [options]

minimal hardcoded-secret scan of the project and dependency install paths

Options:
  -h, --help  display help for command
```

A regex + entropy scan for common credential patterns — in your project files and in
dependency install-path files. It exists because checking for leaked credentials is a
natural follow-up while you're already auditing a tree; it is deliberately **minimal**
and is not the reason to use lockwarden. If you need a dedicated secret scanner with a
large pattern catalogue, use one.

## Flags

`secrets` has no command-specific flags. All
[global flags](/getting-started/#global-flags) apply — in particular `--dir <path>`
(repeatable) to point at monorepo package roots.

## Example 1 — a project with findings

```bash
npx lockwarden secrets
```

```
scanned 6 files, 2 node_modules packages
  HIGH  src/config.js:6  AWS access key ID  AKIA…LE
  LOW   README.md:7  JSON Web Token  eyJh…5c
```

Exit `1` (the High finding meets the default `high` threshold). Matched values are
**always masked** — first and last characters only — in every output mode, including
`--json`. lockwarden never prints a full credential.

## Example 2 — monorepo roots

```bash
npx lockwarden secrets --dir packages/api --dir packages/web
```

## Example 3 — machine-readable

```bash
npx lockwarden secrets --json --ci
```

```json
{
  "command": "secrets",
  "scanned": { "files": 6, "packages": 2 },
  "findings": [
    {
      "file": "src/config.js",
      "line": 6,
      "ruleId": "aws-access-key",
      "ruleName": "AWS access key ID",
      "severity": "high",
      "excerpt": "AKIA…LE"
    },
    {
      "file": "README.md",
      "line": 7,
      "ruleId": "jwt",
      "ruleName": "JSON Web Token",
      "severity": "low",
      "excerpt": "eyJh…5c"
    }
  ],
  "warnings": [],
  "exitCode": 1
}
```

Field tables: [JSON output → secrets](/reference/json-output/#lockwarden-secrets---json).

## The rule set

15 rules, each with a fixed severity:

| Rule id | Detects | Severity |
| --- | --- | --- |
| `aws-access-key` | AWS access key ID | high |
| `aws-secret-key` | AWS secret access key | high |
| `github-token` | GitHub token | high |
| `npm-token` | npm access token | high |
| `stripe-live-key` | Stripe live secret key | high |
| `gcp-service-account` | GCP service account key file | high |
| `private-key-pem` | Private key (PEM) | high |
| `slack-token` | Slack token | med |
| `google-api-key` | Google API key | med |
| `azure-account-key` | Azure storage AccountKey | med |
| `twilio-api-key` | Twilio API key SID | med |
| `sendgrid-api-key` | SendGrid API key | med |
| `generic-high-entropy` | High-entropy value assigned to `secret`/`token`/`password`/`api_key` | med |
| `stripe-test-key` | Stripe test secret key | low |
| `jwt` | JSON Web Token (validated: header and payload must decode as base64url JSON) | low |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No findings at or above `--threshold` |
| `1` | Findings at or above `--threshold` |
| `2` | Execution error |

## Notes

- Runs fully offline, always — `--offline` is trivially satisfied.
- Dependency install paths are included because 2026 malware families harvest
  credentials at install time — a hardcoded token inside `node_modules` is a signal
  worth surfacing while you're triaging.
- Tuning tip: `--threshold med` also fails the run on Slack/Google/Azure-class findings;
  the default `high` fails only on the top severity tier.

## See also

- [Exit codes](/reference/exit-codes/) — wiring `secrets` into CI.
- [`audit`](/commands/audit/) — the execution-surface scan you probably came for.
