---
title: GitHub Action
description: The official lockwarden GitHub Action — every input, the complete workflow with permissions, version pinning including pin-by-SHA, and troubleshooting.
---

Two lines of YAML: execution-surface review on every dependency bump, findings in the
Security tab you already use. No account, no telemetry — the Action is a thin wrapper
and everything the CLI does, it does on your runner.

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

The workflow triggers only on PRs that touch a lockfile. With `diff-base` set, the
Action runs [`audit --diff`](/commands/audit/), which scores **only the packages whose
resolved version changed** — it finishes in seconds, and findings are about what the
bump *introduced* (a new install script, a new `binding.gyp`, a size explosion), not
noise about what always existed. Reviewer's guide to the findings:
[dependency review](/guides/dependency-review/#interpreting-delta-findings).

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `command` | `audit` | `audit` or `check` |
| `diff-base` | *(empty)* | Git ref for delta scoring (PR flow: the PR base sha); omit for a full absolute scan |
| `threshold` | `high` | Severity that fails the check: `low`/`med`/`high`/`critical` |
| `sarif` | `true` | Upload findings to the GitHub Security tab as SARIF |
| `version` | pinned per Action release | Exact CLI version the Action runs — bumped by the release workflow so the Action never floats on `latest` |

What the wrapper actually does: sets up Node 22, runs
`npx --yes lockwarden@<version> <command> --ci --threshold <threshold>` (plus
`--diff <diff-base>` when set, plus `--sarif` redirected to a file when enabled), and
uploads the SARIF via `github/codeql-action/upload-sarif`. Nothing else.

## Version pinning

Two versions are in play, pinned independently:

- **The CLI version** is pinned inside the Action (the `version` input) — each Action
  release pins the CLI release it was tested with. Override it only to hold back or
  fast-forward the CLI deliberately. Remember that
  [vendored advisory data](/incidents/#the-release-cadence-is-the-data-pipeline) rides
  CLI releases: a pinned CLI is also pinned advisory data.
- **The Action ref** is whatever you write after `uses:`. `@v1` follows the v1 line.
  For maximum supply-chain rigor — the standard hardening advice for *any* third-party
  Action, this one included — pin by full commit SHA instead of tag:

  ```yaml
  - uses: itsraghul/lockwarden/packages/action@<full-commit-sha> # v1
  ```

  A tag can be moved; a commit SHA cannot. Trade-off: SHA pins don't receive fixes
  until you bump them — pair with a tool that PRs Action updates (Dependabot's
  `github-actions` ecosystem, Renovate).

## SARIF and the Security tab

With `sarif: true` (the default), findings appear in **Security → Code scanning** on
the repository and as annotations on the PR — no new UI for reviewers to learn.
Severity maps Critical→`error`, High→`warning`, Med→`note` (Low is suppressed by
default; see [Scoring](/scoring/#sarif-mapping)). Findings carry stable fingerprints so
GitHub tracks them across runs rather than re-opening them each push
([SARIF details](/reference/json-output/#sarif-output---sarif)).

The `security-events: write` permission exists solely for this upload. If you set
`sarif: false`, drop the permission and rely on the exit code alone.

## Exit-code behaviour

The Action fails the check when the CLI exits `1` — findings at or above `threshold` —
and errors when the CLI exits `2` ([the contract](/reference/exit-codes/)). That's the
whole integration: lockwarden **detects and reports**; whether a failed check blocks
the merge is your branch-protection policy, not the tool's.

## Troubleshooting

### `--diff` fails: lockfile not found at ref

```
lockwarden: lockfile package-lock.json not found at ref '<sha>'
```

The default `actions/checkout` is a shallow clone (`fetch-depth: 1`) that doesn't
contain the PR base commit. Set `fetch-depth: 0` on the checkout step whenever you pass
`diff-base`. (Fetching just the base branch also works if full history is too heavy.)

### SARIF upload rejected (403 / "Resource not accessible")

The workflow is missing `security-events: write` — add the `permissions` block from the
example. On PRs from forks, GitHub restricts this permission by design; either accept
exit-code-only behaviour for fork PRs (`sarif: false`) or restrict the workflow to
same-repo PRs. Code scanning upload also requires the feature to be available on the
repo (private repos need GitHub Advanced Security).

### Monorepos

- **One workspace-root lockfile** (npm/pnpm/yarn workspaces): nothing special — the
  Action runs at the repo root and audits the single lockfile.
- **Several independently-locked packages:** `audit` analyzes one project per run, so
  run the Action (or raw `npx` with `--dir`) once per package — a job matrix keeps it
  tidy: [CI recipes → monorepos](/guides/ci-recipes/#monorepos-and---dir).
- Keep the `paths:` trigger patterns prefixed with `**/` so nested lockfiles trigger
  the workflow.

### The check is noisy on a first full scan

Without `diff-base` the Action runs an absolute scan, which inventories *existing*
execution surface (Med/Low mostly). Set `diff-base` on PRs — delta findings are the
low-noise signal — and keep absolute scans for scheduled runs where a human reads the
report. [Why delta over absolute →](/project/architecture-decisions/#1-delta-over-absolute-scoring)

## Not on GitHub?

The Action is a convenience wrapper, not the integration. One line of shell does the
same anywhere: [CI recipes](/guides/ci-recipes/) covers GitLab CI, CircleCI, Jenkins,
and a generic template.
