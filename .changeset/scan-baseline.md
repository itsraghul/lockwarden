---
'lockwarden': minor
---

`scan` now supports baseline suppression, same as `audit`: `--write-baseline` accepts an artifact's reviewed findings into `.lockwarden-baseline.json`, and subsequent scans fail only on NEW execution surface. Same file format, version-independent matching, and never-suppressible classes (Layer-2, Critical, delta-on-F). Because an artifact is not a writable project directory, the default baseline path is `.lockwarden-baseline.json` in the first `--dir` (else the current working directory); use `--baseline <path>` for per-artifact baselines. Additive `--json` fields (`suppressed`, `suppressedCounts`, `baseline`) and SARIF `suppressions` match audit's.
