---
"lockwarden": minor
---

`audit` gains baseline suppression: a checked-in `.lockwarden-baseline.json` of reviewed findings so CI fails only on NEW execution surface. `--write-baseline` creates/updates it (preserving reasons, pruning stale entries), `--baseline <path>` overrides the location, `--no-baseline` ignores it. Matching is version-independent (rule code + package name) — accepted surface survives benign version bumps, while delta analyzers and the Layer-2 overlay keep catching what changes. Layer-2 findings, critical findings, and delta findings on grade-F packages are never suppressible. Suppressed findings stay visible: dimmed in human output, a `suppressed` array + `rollup.suppressedCounts` + top-level `baseline` object in `--json` (additive fields), and SARIF results carrying the standard `suppressions` property so GitHub code scanning shows them as suppressed.
