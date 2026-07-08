---
title: CI quickstart
description: Minimal copy-paste to a working lockwarden PR gate in under five minutes — GitHub Actions or any CI with npx.
---

Goal: every PR that touches a lockfile gets a delta-scored execution-surface review, and
findings at or above `high` fail the check. Two paths — pick one.

## Path A — GitHub Actions (the official Action)

Create `.github/workflows/lockwarden.yml`:

```yaml
name: lockwarden
on:
  pull_request:
    paths:
      - '**/package-lock.json'
      - '**/pnpm-lock.yaml'
      - '**/yarn.lock'
      - '**/bun.lock'
permissions:
  contents: read
  security-events: write # SARIF upload
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # --diff needs the base ref
      - uses: itsraghul/lockwarden/packages/action@v1
        with:
          diff-base: ${{ github.event.pull_request.base.sha }}
```

Commit, open a dependency-bump PR, and you'll see:

- a **check** that fails when the bump introduces execution surface at/above `high`;
- findings in **Security → Code scanning** and as PR annotations (SARIF upload).

That's the whole integration. All inputs and troubleshooting:
[GitHub Action](/github-action/).

## Path B — any CI, one line of shell

No Action, no wrapper — the CLI is the integration:

```bash
npx --yes lockwarden@0.3.1 audit --diff "$BASE_SHA" --ci --threshold high
```

- `BASE_SHA` is your platform's PR base ref (GitLab: `$CI_MERGE_REQUEST_DIFF_BASE_SHA`,
  Jenkins: `$CHANGE_TARGET`, …).
- The [exit code is the whole contract](/reference/exit-codes/): `0` passes, `1` fails
  the job, `2` means the run itself broke.
- Requires a checkout deep enough to contain the base ref (full clone, or fetch the base
  branch explicitly).

Complete pipelines for GitLab CI, CircleCI, Jenkins, and a generic template — plus
caching, `--offline` for airgapped runners, and monorepo setups — are in
[CI recipes](/guides/ci-recipes/).

## What you just gated

`audit --diff` delta-scores **only the packages whose resolved version changed** in the
PR, and weights what the change *introduced*: a new install script, a new `binding.gyp`,
a new AI-agent hook, a size explosion, a new transitive dep under a patch bump. Existing,
legitimate execution surface doesn't spam the review. Details:
[`audit`](/commands/audit/) · [scoring model](/scoring/).

## Next steps

- Add [`drift --base`](/commands/drift/) alongside `audit --diff` to catch lockfile
  tampering: [dependency review guide](/guides/dependency-review/).
- Gate release artifacts with [`scan`](/commands/scan/) before deploying.
- Tune `--threshold` per environment: [thresholds per environment](/guides/ci-recipes/#thresholds-per-environment).
