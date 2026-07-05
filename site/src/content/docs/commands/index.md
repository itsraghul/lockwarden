---
title: Commands overview
description: The five lockwarden commands at a glance — what each answers, its network behavior, and where the full reference lives.
---

lockwarden has five commands. Each answers one question, each is CI-composable via the
[exit-code contract](/reference/exit-codes/), and each supports the
[global flags](/getting-started/#global-flags) (`--json`, `--sarif`, `--ci`, `--dir`,
`--threshold`, `--offline`).

| Command | Question it answers | Network | Needs git |
| --- | --- | --- | --- |
| [`check`](/commands/check/) | Am I resolving this package — through any transitive path? Was I ever? | none | only for `--history` |
| [`audit`](/commands/audit/) | What can this tree execute, and what did a change introduce? | previous-tarball fetches in `--diff`/`--deep` only | only for `--diff` |
| [`drift`](/commands/drift/) | Did my lockfile change in ways my manifest doesn't explain? | none | yes |
| [`scan`](/commands/scan/) | What can the artifact I ship actually execute? | none | no |
| [`secrets`](/commands/secrets/) | Are there hardcoded credentials in my project or install paths? | none | no |

```
Usage: lockwarden [options] [command]

Commands:
  audit [options]               execution-surface audit of the resolved
                                dependency tree
  check [options] [queries...]  incident triage: report every path by which a
                                package enters the tree
  drift [options]               lockfile & version-anomaly detection vs a base
                                ref
  scan [options] [artifact]     execution-surface scan of an artifact: tarball,
                                zip, dir, or docker-save image
  secrets                       minimal hardcoded-secret scan of the project and
                                dependency install paths
```

## Which command, when

- **Incident in the news** → [`check`](/commands/check/) (see the
  [incident-response runbook](/guides/incident-response/)).
- **Dependency-bump PR open** → [`audit --diff`](/commands/audit/) +
  [`drift --base`](/commands/drift/) (see [dependency review](/guides/dependency-review/)).
- **First look at a project** → plain [`audit`](/commands/audit/) for the absolute
  execution-surface baseline.
- **About to publish or deploy** → [`scan`](/commands/scan/) on the tarball or
  `docker save`d image.
- **While you're at it** → [`secrets`](/commands/secrets/) for hardcoded credentials.

## Shared behavior

- **The lockfile is the source of truth.** `check`, `audit`, and `drift` resolve from
  `package-lock.json` (v1/v2/v3), `yarn.lock` (classic and berry), or `pnpm-lock.yaml`
  (6.x/9.x) — never from `package.json` alone.
- **Output modes.** Human-readable by default; `--json` for
  [stable machine-readable reports](/reference/json-output/); `--sarif` (on scoring
  commands) for the GitHub Security tab.
- **Exit codes.** `0` clean · `1` findings at/above `--threshold` · `2` execution error.
  Per-command matrix: [exit codes](/reference/exit-codes/).
- **Network.** Only `audit --diff`/`--deep` ever touch the network, and only to fetch
  previous-version tarballs through a
  [single chokepoint module](/trust-model/#the-only-network-calls). `--offline` turns
  any attempt into exit `2`.
