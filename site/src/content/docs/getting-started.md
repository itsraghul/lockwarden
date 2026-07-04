---
title: Getting started
description: Run lockwarden with npx — no install, no account, no config. The three flows and the exit-code API.
---

lockwarden is a local-first CLI that audits what your npm dependency tree can **execute** —
lifecycle install scripts, native build hooks (`binding.gyp`), AI-agent hooks, IDE task
files — and answers *"am I hit?"* during supply-chain incidents.

There is nothing to install and nothing to sign up for:

```bash
npx lockwarden --help
```

It works in any project with a lockfile (`package-lock.json`, `yarn.lock`, or
`pnpm-lock.yaml`). The lockfile is the source of truth — lockwarden never resolves from
`package.json` alone, because transitive resolutions are where real attacks live.

## The three flows

### 1. Incident triage — "am I hit?"

A compromised package is in the news. Ask your lockfile directly:

```bash
npx lockwarden check node-ipc@9.1.6
npx lockwarden check --incident node-ipc-may26   # vendored IOC bundle
npx lockwarden check axios --history              # was I *ever* exposed?
```

`check` reports every transitive path by which the package enters your tree, and
`--history` walks the git log of your lockfile to report exposure windows.
See [`check`](/commands/check/) and [incident bundles](/incidents/).

### 2. PR gate — "what does this bump introduce?"

Before merging a Dependabot/Renovate PR:

```bash
npx lockwarden audit --diff main   # delta-score only the packages that changed
npx lockwarden drift --base main   # lockfile tampering check
```

Or add the two-line [GitHub Action](/github-action/) and get the same review on every PR
that touches a lockfile, with findings in the Security tab.

### 3. Artifact verification — "what's actually in the thing I ship?"

Registry-level scanning never sees `node_modules` pre-baked inside a tarball or Docker
layer:

```bash
npx lockwarden scan ./release.tgz
npx lockwarden scan --image myapp:latest
```

See [`scan`](/commands/scan/).

## Exit codes are the API

Every command is CI-composable. There are exactly three outcomes:

| Exit code | Meaning |
| --- | --- |
| `0` | Clean — no findings at or above `--threshold` |
| `1` | Findings at or above `--threshold` (default: `high`) |
| `2` | Execution error — bad arguments, unparseable lockfile, or a network call attempted under `--offline` |

## Global flags

These apply to every command:

```
--json                machine-readable JSON output
--sarif               SARIF 2.1.0 output (GitHub Security tab)
--ci                  no colour/spinner, exit codes only
--dir <path>          monorepo package root(s), repeatable
--threshold <grade>   minimum severity that triggers exit 1 (default: high)
--offline             hard-fail any network call (exit 2)
```

`--json` and `--sarif` outputs are stable and snapshot-tested — safe to build tooling on.

## Where to next

- [Trust model](/trust-model/) — why local-first is the point, and what the *only* network calls are.
- [Scoring](/scoring/) — the Layer-1 signal table, grades A–F, and the known-bad overlay.
- [Commands](/commands/check/) — the full flag reference for each command.
