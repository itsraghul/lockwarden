---
title: JSON output reference
description: The complete --json schema for every command — field-by-field tables, the SARIF mapping, the stability guarantee, and jq recipes for programmatic consumers.
---

Every command supports `--json`: a single JSON document on stdout, exit code unchanged.
This page is the machine-consumability contract.

## Stability guarantee

`--json` and `--sarif` outputs are **stable and snapshot-tested**. Changes are additive
only — new fields may appear; existing fields keep their names, types, and meanings.
Build tooling on them.

Conventions shared by all commands:

- The document always carries `"command": "<name>"` and (except `audit`/`scan`, where
  the exit code is threshold-derived from the findings) an explicit `"exitCode"` field.
- `warnings` is always an array of human-readable strings for non-fatal conditions
  (e.g. `"1 package(s) not present in node_modules — run install for full coverage"`).
- Severity values are `"none" | "low" | "med" | "high" | "critical"`; grades are
  `"A" | "B" | "C" | "D" | "F"`. See [Scoring](/scoring/).
- Exit code `2` (execution error) prints an error to stderr, not a JSON document — treat
  a non-parseable stdout plus exit `2` as "the run itself failed".

## `lockwarden check --json`

```json
{
  "command": "check",
  "dirs": [
    {
      "dir": "/work/app",
      "lockfile": { "path": "/work/app/package-lock.json", "type": "npm" },
      "warnings": [],
      "queries": [
        {
          "query": "evil-pkg@1.2.3",
          "hit": true,
          "matches": [
            {
              "name": "evil-pkg",
              "version": "1.2.3",
              "devOnly": false,
              "truncated": false,
              "paths": [
                ["<root>", "app-lib@1.0.0", "evil-pkg@1.2.3"],
                ["<root>", "other-lib@2.0.0", "nested-lib@3.0.1", "evil-pkg@1.2.3"]
              ]
            }
          ]
        }
      ]
    }
  ],
  "hit": true,
  "exitCode": 1
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `command` | `"check"` | Command discriminator |
| `incident` | object? | Present with `--incident`: `{ id, name, date }` of the matched bundle |
| `dirs[]` | array | One entry per `--dir` (or the current directory) |
| `dirs[].dir` | string | Absolute project directory |
| `dirs[].lockfile.path` | string | Absolute lockfile path |
| `dirs[].lockfile.type` | `"npm" \| "yarn" \| "pnpm"` | Detected lockfile format |
| `dirs[].warnings[]` | string[] | Non-fatal notes for this directory |
| `dirs[].queries[]` | array | One entry per query (with `--incident`, one per bundled package version) |
| `queries[].query` | string | The query as resolved, e.g. `"evil-pkg@1.2.3"` |
| `queries[].hit` | boolean | Did anything in the resolved tree match |
| `queries[].matches[]` | array | One entry per matching resolved `name@version` |
| `matches[].name` / `.version` | string | The matched package |
| `matches[].devOnly` | boolean | True when every path to it goes through dev dependencies only |
| `matches[].truncated` | boolean | True when path enumeration hit the 500-path cap |
| `matches[].paths[][]` | string[][] | Every dependency path, root-first; `"<root>"` is your project |
| `hit` | boolean | Any hit in any directory |
| `exitCode` | `0 \| 1` | Mirrors the process exit code |

With `--history` the document instead carries a `history` object:

```json
{
  "command": "check",
  "history": {
    "query": "evil-pkg",
    "lockfile": "package-lock.json",
    "commitsExamined": 3,
    "windows": [
      {
        "version": "1.2.3",
        "firstSeen": { "sha": "1f9292d2…", "date": "2026-07-05T16:24:20+05:30" },
        "lastSeen": { "sha": "1f9292d2…", "date": "2026-07-05T16:24:20+05:30" },
        "stillPresent": false
      }
    ]
  },
  "hit": true,
  "exitCode": 1
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `history.query` | string | The queried package |
| `history.lockfile` | string | Lockfile path relative to the repo |
| `history.commitsExamined` | number | Lockfile-touching commits reparsed |
| `history.windows[]` | array | One exposure window per resolved version |
| `windows[].version` | string | The resolved version |
| `windows[].firstSeen` / `.lastSeen` | `{ sha, date }` | Full commit sha + ISO-8601 author date bounding the window |
| `windows[].stillPresent` | boolean | True when the current lockfile still resolves this version |

## `lockwarden audit --json`

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
      "findings": [ /* see Finding below */ ]
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

| Field | Type | Meaning |
| --- | --- | --- |
| `command` | `"audit"` | Command discriminator |
| `mode` | `"absolute" \| "diff" \| "deep"` | Which [audit mode](/commands/audit/#modes) produced the report |
| `lockfile.path` / `.type` | string | As in `check` |
| `packages[]` | array | **Only packages with ≥1 finding**, worst grade first |
| `packages[].key` | string | `"name@version"` |
| `packages[].grade` | Grade | Per-package grade — [how grades derive](/scoring/#grades-af) |
| `packages[].findings[]` | Finding[] | Sorted by severity, highest first |
| `rollup.grade` | Grade | Worst package grade in the tree (`A` when nothing flagged) |
| `rollup.packagesAnalyzed` | number | Total resolved packages |
| `rollup.packagesFlagged` | number | Packages with ≥1 finding |
| `rollup.counts` | object | Finding count per severity |
| `warnings[]` | string[] | Non-fatal notes |

### Baseline fields (additive, only when a baseline is applied)

When a [baseline file](/commands/audit/#baseline) suppresses findings, three optional
fields appear — absent otherwise, per the stability guarantee:

```json
{
  "packages": [
    {
      "name": "with-post",
      "version": "1.0.0",
      "key": "with-post@1.0.0",
      "grade": "A",
      "findings": [],
      "suppressed": [
        {
          "layer": 1,
          "signal": { /* Finding.signal, unchanged */ },
          "severity": "med",
          "suppression": {
            "reason": "postinstall reviewed — writes a local marker file only",
            "addedAt": "2026-07-05"
          }
        }
      ]
    }
  ],
  "rollup": {
    "suppressedCounts": { "none": 0, "low": 0, "med": 1, "high": 0, "critical": 0 }
  },
  "baseline": {
    "path": "/work/app/.lockwarden-baseline.json",
    "entries": 2,
    "matched": 1,
    "expired": 1
  }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `packages[].suppressed[]` | array? | Baseline-suppressed findings: a [Finding](#the-finding-object) plus a `suppression` object |
| `packages[].suppressed[].suppression` | object | `reason?`, `addedAt?`, `expires?` copied from the matching baseline entry |
| `packages[].grade` | Grade | Re-derived from **active** findings only (`F` never improves) |
| `rollup.suppressedCounts` | object? | Suppressed-finding count per severity (active counts stay in `rollup.counts`) |
| `baseline.path` | string | Baseline file that was applied |
| `baseline.entries` | number | Total entries in the file |
| `baseline.matched` | number | Findings suppressed this run |
| `baseline.expired` | number | Entries ignored because their `expires` date passed |

Exit codes and `--threshold` evaluate **active findings only** — that is the point of a
baseline. Layer-2, critical, and grade-F delta findings are
[never suppressible](/commands/audit/#baseline).

### The `Finding` object

A finding is either **Layer 1** (structural signal + corpus-gated severity) or
**Layer 2** (known-bad match, always critical). Discriminate on `layer`:

```json
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
```

| Field | Type | Meaning |
| --- | --- | --- |
| `layer` | `1` | Layer-1 (structural) finding |
| `severity` | Severity | Corpus-gated weight for `(analyzer, kind)` |
| `signal.analyzer` | string | One of `lifecycle-scripts`, `binding-gyp`, `agent-hooks`, `ide-tasks`, `size-delta`, `dep-introduction`, `obfuscation`, `phantom-deps` |
| `signal.code` | string | Stable rule id, e.g. `LW001-LIFECYCLE`; a `D` suffix on the number (`LW001D-…`) marks delta codes |
| `signal.kind` | `"absolute" \| "delta"` | Surface exists vs surface *newly appeared* this version |
| `signal.package` | `{ name, version }` | The package the signal is about |
| `signal.evidence.file` | string? | File inside the package that triggered the signal |
| `signal.evidence.excerpt` | string? | Short quoted evidence |
| `signal.evidence.detail` | string | Human-readable explanation |
| `signal.metrics` | object | Raw numeric facts (analyzer-specific; what corpus calibration tunes against) |

```json
{
  "layer": 2,
  "severity": "critical",
  "code": "LW2-IOC-axios-mar26",
  "package": { "name": "plain-crypto-js", "version": "1.0.0" },
  "layer2": {
    "source": "incident",
    "id": "axios-mar26",
    "summary": "Phantom transitive dependency plain-crypto-js ran a postinstall payload…"
  }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `layer` | `2` | Known-bad overlay finding — [always critical](/scoring/#layer-2--known-bad-overlay) |
| `code` | string | `LW2-OSV-<id>`, `LW2-IOC-<id>`, or `LW2-IOC-<id>-FILE` (file-content IOC match in `scan`) |
| `layer2.source` | `"osv" \| "incident"` | Vendored OSV snapshot vs [incident bundle](/incidents/) |
| `layer2.id` | string | OSV id (`MAL-2026-…`) or incident id (`axios-mar26`) |
| `layer2.summary` | string | Human-readable description from the source |

## `lockwarden drift --json`

```json
{
  "command": "drift",
  "base": "main",
  "lockfile": { "path": "/work/app/package-lock.json", "type": "npm" },
  "findings": [
    {
      "kind": "integrity-swap",
      "severity": "critical",
      "package": "nested-lib@3.0.1",
      "detail": "integrity hash changed for unchanged version nested-lib@3.0.1",
      "evidence": {
        "baseIntegrity": "sha512-N1yz…",
        "currentIntegrity": "sha512-TAMP…"
      }
    }
  ],
  "warnings": [],
  "exitCode": 1
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `base` | string | The git ref compared against |
| `findings[].kind` | string | `integrity-swap` \| `unexplained-version` \| `resolved-url-move` \| `patch-introduced-dep` — see [drift](/commands/drift/#what-it-detects) |
| `findings[].severity` | Severity | Fixed per kind (`integrity-swap` is critical; URL *host* moves are high) |
| `findings[].package` | string | `"name@version"` the anomaly is about |
| `findings[].detail` | string | Human-readable explanation |
| `findings[].evidence` | object | Kind-specific before/after values (`baseIntegrity`/`currentIntegrity`, `baseResolved`/`currentResolved`, `bumps`, …) |
| `exitCode` | `0 \| 1` | Mirrors the process exit code |

## `lockwarden scan --json`

Identical to the `audit` report except:

| Difference | Meaning |
| --- | --- |
| `"command": "scan"` | Discriminator |
| `artifact` replaces `lockfile` | `{ "path": "app.tgz", "kind": "tgz" \| "zip" \| "dir" \| "docker-save", "roots": 2 }` — `roots` counts embedded package roots found |
| `packages[].root` | Path of the package root *inside the artifact*, e.g. `"package/node_modules/evil-thing"` |
| No `mode` field | `scan` is always absolute analysis + Layer-2 overlay |

## `lockwarden secrets --json`

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
    }
  ],
  "warnings": [],
  "exitCode": 1
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `scanned.files` | number | Project files scanned |
| `scanned.packages` | number | `node_modules` packages whose install-path files were scanned |
| `findings[].file` | string | File path relative to the project dir |
| `findings[].line` | number | 1-based line number |
| `findings[].ruleId` / `.ruleName` | string | Which of the [15 rules](/commands/secrets/#the-rule-set) matched |
| `findings[].severity` | Severity | Fixed per rule |
| `findings[].excerpt` | string | **Masked** match — first/last characters only, never the full secret |
| `exitCode` | `0 \| 1` | Mirrors the process exit code |

## SARIF output (`--sarif`)

`audit` and `scan` emit SARIF 2.1.0 (`$schema: https://json.schemastore.org/sarif-2.1.0.json`)
for GitHub code scanning:

- `tool.driver`: name `lockwarden`, the CLI `version`, and one `rules[]` entry per
  distinct rule id encountered.
- One `results[]` entry per finding: `ruleId` is the signal code (`LW001-LIFECYCLE`,
  `LW2-IOC-…`), `level` maps Critical→`error`, High→`warning`, Med→`note`, and Low is
  omitted unless `--verbose`.
- `locations[].physicalLocation.artifactLocation.uri` points at the lockfile (audit) or
  artifact; `logicalLocations[].fullyQualifiedName` is the `name@version`.
- `partialFingerprints["lockwarden/v1"]` is a stable hash so GitHub tracks a finding
  across runs instead of re-opening it each push.
- [Baseline](/commands/audit/#baseline)-suppressed findings are still emitted, with a
  `suppressions: [{ "kind": "external", "justification": "<reason>" }]` property — GitHub
  code scanning shows them as suppressed instead of open.

Upload with `github/codeql-action/upload-sarif` — wired automatically by the
[GitHub Action](/github-action/). SARIF upload is GitHub-specific; on other platforms
consume `--json`.

## jq recipes

Extract every hit path from a `check` (one `→`-joined line per path):

```bash
lockwarden check evil-pkg --json \
  | jq -r '.dirs[].queries[] | select(.hit) | .matches[].paths[] | join(" → ")'
```

Count criticals in an audit:

```bash
lockwarden audit --diff main --json | jq '.rollup.counts.critical'
```

List every package graded D or worse, with its worst finding code:

```bash
lockwarden audit --json | jq -r '
  .packages[] | select(.grade == "D" or .grade == "F")
  | "\(.key)\t\(.grade)\t\(.findings[0].signal.code // .findings[0].code)"'
```

Fail a script only on *delta* findings (ignore absolute inventory):

```bash
lockwarden audit --diff main --json \
  | jq -e '[.packages[].findings[] | select(.signal?.kind == "delta")] | length == 0'
```

Which dependencies actually need install scripts (the
[`ignore-scripts` allowlist](/guides/dependency-review/#the-ignore-scripts-allowlist-workflow)):

```bash
lockwarden audit --json \
  | jq -r '.packages[] | select(any(.findings[]; .signal?.code == "LW001-LIFECYCLE")) | .key'
```

Exposure windows as CSV:

```bash
lockwarden check evil-pkg --history --json \
  | jq -r '.history.windows[] | [.version, .firstSeen.date, .lastSeen.date, .stillPresent] | @csv'
```

## See also

- [Exit codes](/reference/exit-codes/) — the other half of the machine contract.
- [Scoring](/scoring/) — what severities and grades mean.
- Per-command pages for annotated examples: [check](/commands/check/) ·
  [audit](/commands/audit/) · [drift](/commands/drift/) · [scan](/commands/scan/) ·
  [secrets](/commands/secrets/).
