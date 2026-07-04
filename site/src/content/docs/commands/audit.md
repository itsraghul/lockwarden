---
title: lockwarden audit
description: Execution-surface audit of the resolved dependency tree — absolute scan by default, delta scoring with --diff, full-tree deltas with --deep.
---

Execution-surface audit of the resolved dependency tree.

## Synopsis

```bash
npx lockwarden audit [--diff <base-ref>] [--deep] [--verbose]
```

`audit` enumerates every execution vector in the resolved tree — npm lifecycle scripts,
`binding.gyp` / node-gyp build hooks, AI-agent hooks and MCP manifests, IDE task files,
phantom dependencies, obfuscation markers, and file-size anomalies — and grades each
package A–F. See [Scoring](/scoring/) for the full signal table.

## Flags

| Flag | Meaning |
| --- | --- |
| `--diff <base-ref>` | Delta-score only packages whose resolved version changed vs a git ref |
| `--deep` | Full-tree delta scan (fetches previous version of every dep — slow) |
| `--verbose` | Include Low findings in SARIF output |

All [global flags](/getting-started/#global-flags) apply.

## Modes

### Default — absolute scan, zero network

Scores what exists in the tree today using absolute weights only. Runs entirely offline.
Useful as a baseline, but absolute findings are inherently noisier: legitimate native
packages carry `binding.gyp` forever.

### `--diff <base-ref>` — the PR flow

Compares your lockfile against a git ref and computes **delta scores** for only the
packages whose resolved version changed. This is where lockwarden earns its keep: attacks
*introduce* execution surface (a new install script, a new build hook, a size explosion),
and delta scoring flags exactly that with very little noise.

```bash
npx lockwarden audit --diff main            # before merging a Renovate PR
npx lockwarden audit --diff HEAD~1 --sarif  # what did the last commit change?
```

Network note: `--diff` fetches the *previous* tarball of each changed package for
comparison (cached in `~/.lockwarden/cache`). This is one of the only two network
operations in the entire tool — see [Trust model](/trust-model/).

### `--deep` — full-tree delta

Fetches the previous version of **every** dependency and delta-scores the whole tree.
Explicitly slow; intended for periodic scheduled runs, not PRs.

## Examples

```bash
npx lockwarden audit                          # absolute scan, no network
npx lockwarden audit --diff main --ci         # PR gate, exit code only
npx lockwarden audit --diff main --sarif      # for the GitHub Security tab
npx lockwarden audit --offline                # airgapped: hard-fails if any fetch is attempted
npx lockwarden audit --threshold critical     # only Critical findings fail the run
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No findings at or above `--threshold` (default: `high`) |
| `1` | Findings at or above `--threshold` |
| `2` | Execution error — unparseable lockfile, unknown git ref, or a network call attempted under `--offline` |

## Output

- `--json`: stable per-package findings with signal, severity, and grade.
- `--sarif`: SARIF 2.1.0 mapped Critical→`error`, High→`warning`, Med→`note`; Low is
  suppressed unless `--verbose`. Uploadable straight to the GitHub Security tab (the
  [GitHub Action](/github-action/) does this for you).
