---
title: lockwarden audit
description: Execution-surface audit of the resolved dependency tree — absolute scan by default, delta scoring with --diff, full-tree deltas with --deep. Every flag, real output, JSON shape.
---

Execution-surface audit of the resolved dependency tree.

## Synopsis

```bash
lockwarden audit [--diff <base-ref> | --deep] [--verbose] [--baseline <path> | --no-baseline] [--write-baseline]
```

```
Usage: lockwarden audit [options]

execution-surface audit of the resolved dependency tree

Options:
  --diff <base-ref>  delta-score only packages whose resolved version changed vs
                     a git ref
  --deep             full-tree delta scan (fetches previous version of every dep
                     — slow) (default: false)
  --verbose          include Low findings in SARIF output (default: false)
  --baseline <path>  baseline file (default: <dir>/.lockwarden-baseline.json)
  --no-baseline      ignore any baseline file
  --write-baseline   create/update the baseline from current findings (default:
                     false)
  -h, --help         display help for command
```

`audit` enumerates every execution vector in the resolved tree — npm lifecycle scripts,
`binding.gyp` / node-gyp build hooks, AI-agent hooks and MCP manifests, IDE task files,
phantom dependencies, obfuscation markers, and file-size anomalies — and grades each
package A–F. See [Scoring](/scoring/) for the full signal table.

## Flags

| Flag | Type | Default | Meaning |
| --- | --- | --- | --- |
| `--diff <base-ref>` | string | — | Delta-score only packages whose resolved version changed vs a git ref |
| `--deep` | boolean | `false` | Full-tree delta scan — fetches the previous version of *every* dependency (slow) |
| `--verbose` | boolean | `false` | Include Low findings in SARIF output |
| `--baseline <path>` | string | `<dir>/.lockwarden-baseline.json` | Baseline file location; an explicit path must exist (exit `2` otherwise) |
| `--no-baseline` | boolean | `false` | Ignore any baseline file |
| `--write-baseline` | boolean | `false` | Create/update the [baseline](#baseline) from current findings, then exit `0` |

`--diff` and `--deep` are **mutually exclusive** (combining them exits `2`). All
[global flags](/getting-started/#global-flags) apply. `audit` analyzes one project per
run — with multiple `--dir` values, the first is used and the rest are ignored with a
warning (run once per directory for monorepos; see
[CI recipes → monorepos](/guides/ci-recipes/#monorepos-and---dir)).

## Modes

### Default — absolute scan, zero network

Scores what exists in the tree today using absolute weights only. Analyzes package
contents from `node_modules` (packages not installed are skipped with a warning — Layer-2
known-bad matching still covers every resolved version). Runs entirely offline.

### `--diff <base-ref>` — the PR flow

Compares the working lockfile against the one committed at `<base-ref>` and delta-scores
**only the packages whose resolved version changed**. For each changed package it fetches
the *previous* version's tarball (SRI-verified against the base lockfile's integrity
hash, cached in `~/.lockwarden/cache`) and scores what the new version *introduced* —
the signal every 2026 attack exhibited. These fetches are the
[only network calls in the tool](/trust-model/#the-only-network-calls).

### `--deep` — full-tree delta

Fetches the previous version of **every** dependency and delta-scores the whole tree.
Explicitly slow; intended for periodic scheduled runs, not PRs.

## Baseline

Real trees carry *accepted* execution surface — esbuild's install script, sharp's native
binaries. Without a baseline, adopting `--threshold med` or `low` in CI means failing on
findings you have already reviewed. A **baseline file** records those accepted findings so
CI fails only on **new** ones — the [delta-over-absolute](/project/architecture-decisions/#1-delta-over-absolute-scoring)
rule applied to adoption.

```bash
# Review current findings, then accept them:
lockwarden audit --write-baseline

# Commit the file; from now on only NEW findings fail the run:
lockwarden audit --ci --threshold med
```

`--write-baseline` writes `.lockwarden-baseline.json` next to the lockfile (or to
`--baseline <path>`):

```json
{
  "version": 1,
  "generatedAt": "2026-07-05",
  "tool": "lockwarden@0.4.0",
  "entries": [
    {
      "code": "LW002-BINDING-GYP",
      "package": "with-gyp",
      "version": "1.0.0",
      "addedAt": "2026-07-05"
    },
    {
      "code": "LW001-LIFECYCLE",
      "package": "with-post",
      "version": "1.0.0",
      "addedAt": "2026-07-05"
    }
  ]
}
```

Entries are cleartext and diff-reviewable. `code` + `package` are the match key; add a
`"reason"` (shown as the SARIF suppression justification) and an optional `"expires"`
ISO date (on/after it, the entry stops suppressing and a warning is printed). `version`
and `addedAt` are audit trail only.

**Matching is version-independent.** An accepted `LW001-LIFECYCLE` on `esbuild` stays
accepted when esbuild bumps 0.21.5 → 0.21.6 — the surface that *persists* across versions
is exactly what a baseline is for. What **changes** between versions is caught by the
delta analyzers (`--diff`) and the Layer-2 known-bad overlay, which a baseline can never
mute:

- **Layer-2 findings** (known-bad packages) are never suppressible.
- **Critical findings** are never suppressible.
- **Delta findings on a grade-F package** are never suppressible (protects
  corpus-elevated compound Criticals).

`--write-baseline` skips these with a printed note; hand-edited entries matching them are
ignored with a warning. Suppressed findings stay visible: dimmed `[suppressed]` lines in
human output, a `suppressed` array per package in [`--json`](/reference/json-output/),
and SARIF results carrying the standard `suppressions` property (GitHub code scanning
shows them as suppressed instead of open).

Re-running `--write-baseline` preserves the `addedAt`/`reason`/`expires` of surviving
entries and prunes entries that no longer match anything.

## Example 1 — absolute scan

```bash
npx lockwarden audit
```

```
grade C — 2 packages flagged of 2 analyzed
med 1 · low 1
lockfile: package-lock.json (npm) — mode: absolute

  with-post@1.0.0 — grade C
    [med] LW001-LIFECYCLE package.json — lifecycle script "postinstall" runs automatically on install

  with-gyp@1.0.0 — grade B
    [low] LW002-BINDING-GYP binding.gyp — native build hook: binding.gyp present (binding.gyp)
```

Exit `0` — a `postinstall` and a `binding.gyp` *existing* is Med/Low, below the default
`high` threshold. Absolute findings are inventory, not alarm: legitimate native packages
carry `binding.gyp` forever. (This output also feeds the
[`ignore-scripts` allowlist workflow](/guides/dependency-review/#the-ignore-scripts-allowlist-workflow).)

## Example 2 — `--diff`: what did this bump introduce?

```bash
npx lockwarden audit --diff main
```

```
grade F — 2 packages flagged of 2 analyzed
critical 2 · med 2
lockfile: package-lock.json (npm) — mode: diff

  dep-a@1.0.1 — grade F
    [critical] LW001D-LIFECYCLE-INTRODUCED package.json — lifecycle script "postinstall" is NEW in 1.0.1 (absent in 1.0.0)
    [med] LW001-LIFECYCLE package.json — lifecycle script "postinstall" runs automatically on install
    [med] LW008-PHANTOM package.json — declared dependency "dep-b" (^1.0.0) is never imported in 2 JS/TS files (plain-crypto-js pattern)

  dep-b@1.0.0 — grade F
    [critical] LW006D-PATCH-DEP-INTRODUCED — new transitive dependency dep-b@1.0.0 entered the tree alongside patch bump(s): dep-a 1.0.0 → 1.0.1
```

Exit `1`. The same script that is `med` for existing is **Critical** for being new
(`LW001D`), and the new transitive dep arriving under a patch bump is Critical on its own
(`LW006D`) — the axios/`plain-crypto-js` shape. Interpreting each delta code:
[dependency review](/guides/dependency-review/#interpreting-delta-findings).

## Example 3 — CI variants

```bash
npx lockwarden audit --diff main --ci                 # PR gate: exit code only
npx lockwarden audit --diff HEAD~1 --sarif            # what did the last commit change?
npx lockwarden audit --offline                        # airgapped: exit 2 if any fetch attempted
npx lockwarden audit --diff main --offline            # works when the tarball cache is warm
npx lockwarden audit --threshold critical             # only Critical findings fail the run
```

The `--offline` failure mode, verbatim:

```
lockwarden: --offline is set but a network call to https://registry.npmjs.org/nested-lib/-/nested-lib-3.0.2.tgz was attempted
  hint: Remove --offline, or avoid flags that require tarball fetches (--diff/--deep).
```

Exit `2`. With a warm cache the same command succeeds — cache hits never touch the
network. See [the warm-cache pattern](/guides/ci-recipes/#--offline-for-airgapped-runners).

## `--json` output

Stable, snapshot-tested shape (trimmed to one finding here):

```json
{
  "command": "audit",
  "mode": "diff",
  "lockfile": { "path": "/work/app/package-lock.json", "type": "npm" },
  "packages": [
    {
      "name": "dep-a",
      "version": "1.0.1",
      "key": "dep-a@1.0.1",
      "grade": "F",
      "findings": [
        {
          "layer": 1,
          "signal": {
            "analyzer": "lifecycle-scripts",
            "code": "LW001D-LIFECYCLE-INTRODUCED",
            "kind": "delta",
            "package": { "name": "dep-a", "version": "1.0.1" },
            "evidence": {
              "file": "package.json",
              "excerpt": "\"postinstall\": \"node install.js\"",
              "detail": "lifecycle script \"postinstall\" is NEW in 1.0.1 (absent in 1.0.0)"
            },
            "metrics": { "introduced": 1, "changed": 0 }
          },
          "severity": "critical"
        }
      ]
    }
  ],
  "rollup": {
    "grade": "F",
    "packagesAnalyzed": 2,
    "packagesFlagged": 2,
    "counts": { "none": 0, "low": 0, "med": 2, "high": 0, "critical": 2 }
  },
  "warnings": []
}
```

Only flagged packages appear in `packages`. When a [baseline](#baseline) is applied,
three additive fields appear: a top-level `baseline` object
(`{ path, entries, matched, expired }`), `rollup.suppressedCounts`, and a per-package
`suppressed` array (each element is a finding plus a
`suppression: { reason?, addedAt?, expires? }` object) — packages whose findings are all
suppressed stay in `packages` with re-derived grades. Full field tables:
[JSON output → audit](/reference/json-output/#lockwarden-audit---json).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No findings at or above `--threshold` (default: `high`) |
| `1` | Findings at or above `--threshold` |
| `2` | Execution error — unparseable lockfile, lockfile missing at the `--diff` ref, `--diff` combined with `--deep`, invalid `--threshold`, a malformed or missing explicit `--baseline` file, `--write-baseline` combined with `--json`/`--sarif`/`--no-baseline`, or a network call attempted under `--offline` |

## Output modes

- `--json`: the [stable report](/reference/json-output/#lockwarden-audit---json) above.
- `--sarif`: SARIF 2.1.0 mapped Critical→`error`, High→`warning`, Med→`note`; Low is
  suppressed unless `--verbose`. Uploadable straight to the GitHub Security tab (the
  [GitHub Action](/github-action/) does this for you).

## See also

- [Scoring](/scoring/) — weights, grades, elevations, the corpus gate.
- [Dependency review](/guides/dependency-review/) — the review workflow around `--diff`.
- [`drift`](/commands/drift/) — the companion lockfile-tampering check.
- [`scan`](/commands/scan/) — the same analysis applied to shipped artifacts.
