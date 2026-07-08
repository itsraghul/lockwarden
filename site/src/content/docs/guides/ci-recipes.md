---
title: CI recipes
description: Complete, copy-paste lockwarden integrations for GitHub Actions, GitLab CI, CircleCI, Jenkins, and any other CI — with caching, thresholds, --offline, and monorepo patterns.
---

Every recipe on this page implements the same gate:

```bash
npx --yes lockwarden@0.3.1 audit --diff "$BASE_SHA" --ci --threshold high
```

Delta-score the packages a PR changed, fail on findings at/above `high`, pass otherwise.
The [exit code](/reference/exit-codes/) is the entire integration contract — lockwarden
never blocks anything itself; your CI's pass/fail policy does. See
[`audit`](/commands/audit/) for what delta scoring detects and
[`drift`](/commands/drift/) for the companion tampering check.

Two universal notes before the recipes:

- **Checkout depth.** `--diff <ref>` reads the base lockfile from local git history. A
  shallow clone that lacks the base ref makes `audit --diff` exit `2`. Either clone
  fully or fetch the base branch explicitly.
- **Version pinning.** Pin an exact CLI version (`lockwarden@0.3.1`) for reproducible
  runs, and bump it routinely — vendored advisory data ([incident bundles](/incidents/),
  the OSV snapshot) updates with each release.

## GitHub Actions — official Action

```yaml
# .github/workflows/lockwarden.yml
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
  security-events: write
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: itsraghul/lockwarden/packages/action@v1
        with:
          diff-base: ${{ github.event.pull_request.base.sha }}
          threshold: high
```

| Line | Why |
| --- | --- |
| `on.pull_request.paths` | Run only when a lockfile changes — dependency PRs, not every PR. |
| `permissions.security-events: write` | Needed solely for the SARIF upload to the Security tab; drop it if you set `sarif: false`. |
| `fetch-depth: 0` | Full history so `--diff` can read the lockfile at the PR base. |
| `diff-base: …base.sha` | The PR base commit — delta-scores exactly what the PR changes. |
| `threshold: high` | Findings at/above `high` fail the check (the default; shown for clarity). |

All inputs, SHA-pinning, and troubleshooting: [GitHub Action](/github-action/).

## GitHub Actions — raw npx

If you'd rather not use the Action wrapper (or you want to compose flags yourself):

```yaml
# .github/workflows/lockwarden.yml
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
  security-events: write
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: cache previous-version tarballs
        uses: actions/cache@v4
        with:
          path: ~/.lockwarden/cache
          key: lockwarden-cache-${{ runner.os }}
      - name: lockwarden audit (SARIF)
        run: >
          npx --yes lockwarden@0.3.1 audit
          --diff "${{ github.event.pull_request.base.sha }}"
          --ci --threshold high --sarif > lockwarden.sarif
      - name: upload SARIF
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: lockwarden.sarif
```

| Step | Why |
| --- | --- |
| `actions/cache` on `~/.lockwarden/cache` | `--diff` fetches previous-version tarballs; the cache makes repeat runs fetch nothing. |
| `--sarif > lockwarden.sarif` | SARIF goes to stdout; redirect it to a file for upload. The exit code still carries the verdict. |
| `if: always()` on upload | Upload findings even when the audit step failed the job (exit `1`) — that's exactly when you want them visible. |
| `github/codeql-action/upload-sarif` | Publishes to Security → Code scanning. **SARIF upload is a GitHub feature** — on other platforms, use `--json` or the exit code. |

## GitLab CI

```yaml
# .gitlab-ci.yml
lockwarden:
  image: node:22
  stage: test
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      changes:
        - '**/package-lock.json'
        - '**/pnpm-lock.yaml'
        - '**/yarn.lock'
        - '**/bun.lock'
  variables:
    GIT_DEPTH: 0
  cache:
    key: lockwarden-cache
    paths:
      - .lockwarden-cache/
  script:
    - export LOCKWARDEN_CACHE_DIR="$CI_PROJECT_DIR/.lockwarden-cache"
    - npx --yes lockwarden@0.3.1 audit
      --diff "$CI_MERGE_REQUEST_DIFF_BASE_SHA" --ci --threshold high
```

| Line | Why |
| --- | --- |
| `rules: … changes:` | Only merge requests that touch a lockfile trigger the job. |
| `GIT_DEPTH: 0` | Disable GitLab's default shallow clone so the MR base sha exists locally. |
| `LOCKWARDEN_CACHE_DIR` inside the project dir | GitLab's `cache:` can only persist paths under the project directory, so point lockwarden's tarball cache there. |
| `$CI_MERGE_REQUEST_DIFF_BASE_SHA` | GitLab's equivalent of the PR base commit. |

## CircleCI

```yaml
# .circleci/config.yml
version: 2.1
jobs:
  lockwarden:
    docker:
      - image: cimg/node:22.9
    steps:
      - checkout
      - restore_cache:
          keys:
            - lockwarden-cache-v1
      - run:
          name: lockwarden audit --diff
          command: |
            BASE_SHA=$(git merge-base HEAD origin/main)
            npx --yes lockwarden@0.3.1 audit --diff "$BASE_SHA" --ci --threshold high
      - save_cache:
          key: lockwarden-cache-v1
          paths:
            - ~/.lockwarden/cache
workflows:
  audit:
    jobs:
      - lockwarden
```

| Line | Why |
| --- | --- |
| `checkout` | CircleCI's default checkout is a full clone, so the base ref is available. |
| `git merge-base HEAD origin/main` | CircleCI has no built-in "PR base sha" variable; the merge base against your default branch is the robust equivalent. |
| `restore_cache` / `save_cache` | Persist `~/.lockwarden/cache` between runs so previous-version tarballs are fetched once. |

To run only when lockfiles change, add a path filter (e.g. the `path-filtering` orb) —
CircleCI has no native `paths:` trigger.

## Jenkins (declarative pipeline)

```groovy
// Jenkinsfile
pipeline {
  agent { docker { image 'node:22' } }
  options { skipDefaultCheckout(false) }
  stages {
    stage('lockwarden') {
      when { changeRequest() }
      steps {
        sh '''
          git fetch origin "+refs/heads/${CHANGE_TARGET}:refs/remotes/origin/${CHANGE_TARGET}"
          BASE_SHA=$(git merge-base HEAD "origin/${CHANGE_TARGET}")
          npx --yes lockwarden@0.3.1 audit --diff "$BASE_SHA" --ci --threshold high
        '''
      }
    }
  }
}
```

| Line | Why |
| --- | --- |
| `when { changeRequest() }` | Run the stage only for PR builds. |
| `git fetch origin …CHANGE_TARGET` | Multibranch pipelines often clone only the PR branch; fetch the target branch so the base ref exists. |
| `git merge-base HEAD origin/$CHANGE_TARGET` | The PR base commit, computed locally. |
| `sh` exit propagation | A non-zero exit (`1` findings, `2` error) fails the stage — no plugin needed. |

To persist `~/.lockwarden/cache` across builds on ephemeral agents, mount a volume or
use a workspace cache plugin and set `LOCKWARDEN_CACHE_DIR` to the cached path.

## Any other CI — the generic recipe

lockwarden needs exactly three things: Node 20.12+, a git checkout containing the base
ref, and one command.

```bash
#!/usr/bin/env sh
set -e
# 1. BASE_SHA: your platform's "what is this PR against" ref.
BASE_SHA="${BASE_SHA:-$(git merge-base HEAD origin/main)}"
# 2. The gate. Exit 0 = pass, 1 = findings, 2 = broken run.
npx --yes lockwarden@0.3.1 audit --diff "$BASE_SHA" --ci --threshold high
```

Want to distinguish "findings" from "the run itself broke" in your pipeline logic?

```bash
npx --yes lockwarden@0.3.1 audit --diff "$BASE_SHA" --ci --threshold high
code=$?
case $code in
  0) echo "clean" ;;
  1) echo "execution-surface findings — review required"; exit 1 ;;
  2) echo "lockwarden run failed (bad ref / lockfile / network policy)"; exit 2 ;;
esac
```

## Thresholds per environment

`--threshold` sets the severity at which findings flip the exit code to `1`
(accepted values: `low`/`med`/`medium`/`high`/`critical`, or grade letters
`B`/`C`/`D`/`F`). A pattern that works well:

| Environment | Command | Rationale |
| --- | --- | --- |
| PR gate | `audit --diff $BASE --threshold high` | Block on High/Critical; report Med/Low without failing. |
| Nightly / scheduled | `audit --deep --threshold med` | Slower full-tree deltas; stricter bar, humans triage the report. |
| Release / deploy | `scan dist.tgz --threshold high` + `check --incident <id>` for active incidents | Gate the artifact you actually ship. |
| Airgapped / regulated | any command + `--offline` | Prove no network was touched (exit `2` otherwise). |

Findings *below* the threshold are still printed and still appear in
[`--json`](/reference/json-output/)/`--sarif` output — the threshold only controls the
exit code.

## Caching `~/.lockwarden/cache`

`audit --diff` and `--deep` fetch **previous-version tarballs** for comparison — the
[only network calls in the tool](/trust-model/#the-only-network-calls). They're cached
by URL hash in `~/.lockwarden/cache` (override with `LOCKWARDEN_CACHE_DIR`), and every
fetched tarball is SRI-verified against the lockfile's integrity hash before it is
cached. Persisting that directory between CI runs means each previous version is fetched
at most once, ever. The recipes above show the mechanism per platform.

## `--offline` for airgapped runners

`--offline` hard-fails the run (exit `2`) the moment any network call is *attempted*:

```
lockwarden: --offline is set but a network call to https://registry.npmjs.org/nested-lib/-/nested-lib-3.0.2.tgz was attempted
  hint: Remove --offline, or avoid flags that require tarball fetches (--diff/--deep).
```

Plain `audit`, `check`, `drift`, `scan`, and `secrets` never touch the network, so
`--offline` is free to add everywhere. For **delta scoring on airgapped runners**, use
the warm-cache pattern:

1. On a connected machine (or a scheduled connected job), run
   `lockwarden audit --diff <ref>` to populate `~/.lockwarden/cache`.
2. Ship/mount that directory to the airgapped runner (set `LOCKWARDEN_CACHE_DIR`).
3. Run `audit --diff <ref> --offline` there. Cache hits never touch the network — only
   an *actually required* fetch trips the guarantee, so a warm cache passes cleanly.

## Lockfile-paths-only triggers

Execution surface changes only when resolutions change, so trigger on lockfile paths and
skip everything else — the GitHub (`on.pull_request.paths`) and GitLab
(`rules: changes:`) recipes above show the syntax. Two caveats:

- Include **all** lockfile names your repos use (`package-lock.json`,
  `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`) — and the glob prefix `**/` for
  monorepos.
- If you also run [`drift`](/commands/drift/) as a tamper check, keep the same trigger:
  drift findings are, by definition, lockfile changes.

## Monorepos and `--dir`

`--dir <path>` points lockwarden at a package root other than the current directory, and
is repeatable.

- [`check`](/commands/check/) and [`secrets`](/commands/secrets/) accept **multiple**
  `--dir` flags and report per directory — one command can triage every workspace:

  ```bash
  npx lockwarden check evil-pkg@1.2.3 --dir packages/api --dir packages/web
  ```

- [`audit`](/commands/audit/) analyzes **one project per run** (extra `--dir` values are
  ignored with a warning). For several independently-locked packages, run it per
  directory — e.g. a GitHub Actions matrix:

  ```yaml
  strategy:
    matrix:
      dir: [packages/api, packages/web]
  steps:
    # … checkout as above …
    - run: >
        npx --yes lockwarden@0.3.1 audit
        --dir ${{ matrix.dir }}
        --diff "${{ github.event.pull_request.base.sha }}"
        --ci --threshold high
  ```

- A single workspace-root lockfile (the common pnpm/yarn/npm-workspaces setup) needs no
  `--dir` gymnastics at all: one lockfile, one `audit` run at the root.

## See also

- [CI quickstart](/quickstart-ci/) — the five-minute version.
- [GitHub Action](/github-action/) — inputs, permissions, troubleshooting.
- [Dependency review](/guides/dependency-review/) — what to do when the gate fires.
- [JSON output](/reference/json-output/) — build your own reporting on `--json`.
