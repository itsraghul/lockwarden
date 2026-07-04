---
title: GitHub Action
description: Two lines of YAML — execution-surface review on every dependency bump, findings in the GitHub Security tab.
---

Two lines of YAML: execution-surface review on every dependency bump, findings in the
Security tab you already use. No account, no telemetry — analysis runs entirely on your
runner.

## The PR gate

```yaml
# .github/workflows/lockwarden.yml
name: lockwarden
on:
  pull_request:
    paths:
      - '**/package-lock.json'
      - '**/pnpm-lock.yaml'
      - '**/yarn.lock'
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

The workflow triggers only on PRs that touch a lockfile. With `diff-base` set, the Action
runs `audit --diff`, which scores **only the packages whose resolved version changed** —
it finishes in seconds, and findings are about what the bump *introduced* (a new install
script, a new `binding.gyp`, a size explosion), not noise about what always existed.

:::caution[fetch-depth: 0 is required for delta scoring]
`--diff` resolves the base lockfile from git history. The default shallow checkout
(`fetch-depth: 1`) doesn't contain the base ref, so delta scoring would fail. Keep
`fetch-depth: 0` on the checkout step whenever you pass `diff-base`.
:::

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `command` | `audit` | `audit` or `check` |
| `diff-base` | — | Git ref for delta scoring; omit for a full absolute scan |
| `threshold` | `high` | Severity that fails the check |
| `sarif` | `true` | Upload results to the GitHub Security tab |
| `version` | pinned | Exact CLI version the action runs |

The Action is a thin wrapper: it pins the CLI version, runs it with `--ci --sarif`, and
uploads the SARIF via `github/codeql-action/upload-sarif`. Everything the CLI does, it
does on your runner.

## SARIF and the Security tab

With `sarif: true` (the default), findings appear in **Security → Code scanning** on the
repository and as annotations on the PR — no new UI for reviewers to learn. Severity maps
as Critical→`error`, High→`warning`, Med→`note` (Low is suppressed by default; see
[Scoring](/scoring/#sarif-mapping)).

The `security-events: write` permission in the workflow above exists solely for this
upload. If you set `sarif: false`, you can drop it and rely on the exit code alone.

## Exit-code behaviour

The Action fails the check when the CLI exits `1` — findings at or above `threshold` —
and errors when the CLI exits `2`. That's the whole contract: lockwarden **detects and
reports**; whether a failed check blocks the merge is your branch-protection policy, not
the tool's.
