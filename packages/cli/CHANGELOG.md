# lockwarden

## 0.9.0

### Minor Changes

- 8144650: New `lockwarden explain [code]` command: what a finding code detects, why it carries its weights, and what to do when it fires — fully offline, always exit 0 (2 for an unknown code). Accepts family ids (`LW001`), full absolute/delta codes, analyzer ids (`lifecycle-scripts`), and Layer-2 codes; a full dynamic code like `LW2-IOC-<incident-id>` also resolves the vendored advisory it points at. Severities are read live from the corpus-locked weights table so `explain` can never disagree with what `audit` scores. Stable `--json` shape documented in the JSON output reference.

## 0.8.0

### Minor Changes

- 9a4dae9: New `lockwarden incidents` command: list every incident IOC bundle this build knows — the valid ids for `check --incident <id>` — newest first, with dates, package counts, file-IOC counts, and an OSV-snapshot summary line. Purely informational (always exit 0; exit 2 only on execution errors). `LOCKWARDEN_INCIDENT_DIR` overlays are marked `[local overlay]` / `"local": true`. Stable `--json` shape documented in the JSON output reference. The `check --incident` unknown-id hint now points at it.

## 0.7.0

### Minor Changes

- 6891c92: `scan` now supports baseline suppression, same as `audit`: `--write-baseline` accepts an artifact's reviewed findings into `.lockwarden-baseline.json`, and subsequent scans fail only on NEW execution surface. Same file format, version-independent matching, and never-suppressible classes (Layer-2, Critical, delta-on-F). Because an artifact is not a writable project directory, the default baseline path is `.lockwarden-baseline.json` in the first `--dir` (else the current working directory); use `--baseline <path>` for per-artifact baselines. Additive `--json` fields (`suppressed`, `suppressedCounts`, `baseline`) and SARIF `suppressions` match audit's.

## 0.6.1

### Patch Changes

- OSV snapshot refresh 2026-07-07: 5601 entries (+5594 new / −0 removed, 6mo window)

## 0.6.0

### Minor Changes

- 9620093: Advisory-data freshness surfacing: `audit` and `scan` reports gain an additive `advisories` object (`osvGeneratedAt`, `newestIncident` — dates only) plus a human-output freshness line; new global `--max-advisory-age <days>` exits 2 when the vendored advisory data is older than the limit (applies to `audit`, `scan`, and `check --incident`; plain `check` and `--history` are exempt — they never read advisory data). The vendored OSV snapshot migrates to a metadata wrapper with a `generatedAt` stamp. Also: `scan` now supports zip64 archives (>65,535 entries — large lambda bundles); per-entry zip64 (≥4GiB entries) remains unsupported with a clear error.

## 0.5.1

### Patch Changes

- a208092: lifecycle-scripts: a CHANGED install-script body no longer fires the delta Critical when both the old and new bodies are pure native-toolchain invocations (node-gyp, node-gyp-build, node-pre-gyp, prebuild-install, prebuildify, cmake-js with plain arguments) — toolchain migrations like bcrypt 6.0.0's node-pre-gyp → prebuildify swap are not payload changes. Freshly introduced hooks always signal, and any non-toolchain segment (e.g. `&& node payload.js`, the node-ipc shape) still fires — guarded by new corpus tamper fixtures. Validated by the full top-500 corpus run (gate PASS: 0 benign delta Criticals across 496 real version bumps; all 22 malicious fixtures grade F), which locks the scoring weights as no-longer-provisional.

## 0.5.0

### Minor Changes

- 768a36b: `audit` gains baseline suppression: a checked-in `.lockwarden-baseline.json` of reviewed findings so CI fails only on NEW execution surface. `--write-baseline` creates/updates it (preserving reasons, pruning stale entries), `--baseline <path>` overrides the location, `--no-baseline` ignores it. Matching is version-independent (rule code + package name) — accepted surface survives benign version bumps, while delta analyzers and the Layer-2 overlay keep catching what changes. Layer-2 findings, critical findings, and delta findings on grade-F packages are never suppressible. Suppressed findings stay visible: dimmed in human output, a `suppressed` array + `rollup.suppressedCounts` + top-level `baseline` object in `--json` (additive fields), and SARIF results carrying the standard `suppressions` property so GitHub code scanning shows them as suppressed.

## 0.4.0

### Minor Changes

- 457bc15: New analyzer `native-binary` (LW009/LW009D): prebuilt native-binary execution surface — shipped `.node` files (native code that loads at require-time with no `binding.gyp` and possibly no lifecycle script) and prebuilt-binary fetcher toolchains (`prebuild-install`, `node-pre-gyp`, `@mapbox/node-pre-gyp`, `node-gyp-build`, `prebuildify`) in runtime deps or scripts. Corpus-gated weights: absolute Low, delta Critical (0/60 benign noise, all synthetic fixtures grade F). Trees shipping platform binaries (sharp, esbuild/rollup platform packages, fsevents) gain Low findings — this can flip exit codes only for `--threshold low` runs.

## 0.3.1

### Patch Changes

- c95f10e: Docs: point the package homepage at lockwarden.dev and repoint incident-bundle
  reference URLs at the published docs site (the internal planning docs they
  previously linked were removed from the public repo). No behavior change.

## 0.3.0

### Minor Changes

- 98b6715: v0.3 — `drift`, `scan`, and `secrets` complete the v1 command surface.

  - `lockwarden drift [--base <ref>]` — lockfile tampering detection: integrity
    swaps on unchanged versions (Critical), resolved-URL host moves, version
    changes unexplained by package.json, new packages arriving via patch/minor
    bumps. Provenance is reported as informational only — never a pass signal.
  - `lockwarden scan <artifact> | --image <docker-image>` — execution-surface +
    known-bad analysis of what is ACTUALLY on disk: vendored node_modules inside
    tarballs, zips, directories, and docker-save layers (later-layer-wins,
    whiteouts honored). Catches pre-baked tampering no registry scanner sees.
    Incident-bundle fileIocs sha256 matching included. Fully offline.
  - `lockwarden secrets [--dir <path>]` — minimal credential scan (15 curated
    patterns + entropy) over project source and dependency install-path files.
    Secrets are always masked in every output mode.
  - Incident-day automation: one workflow dispatch takes an IOC bundle JSON
    through validation, self-test, npm patch publish, and an auto-merged PR.

## 0.2.0

### Minor Changes

- 70007d4: v0.2 — `audit`: the execution-surface wedge.

  - `lockwarden audit` — enumerates every execution vector in the resolved tree
    (lifecycle scripts, binding.gyp/node-gyp, AI-agent hooks & MCP manifests, IDE
    task files, obfuscation markers, phantom deps) from what is actually installed
    in node_modules. Zero network.
  - `audit --diff <base-ref>` — the PR flow: delta-scores only packages whose
    resolved version changed vs the base lockfile, fetching previous tarballs from
    the base lockfile's own resolved URLs (SRI-verified, cached in ~/.lockwarden).
    Newly _introduced_ execution surface scores Critical — the corpus-calibrated
    signal every 2026 incident exhibited.
  - `audit --deep` — full-tree delta against previous published versions (slow, for
    scheduled runs).
  - Grades A–F per package + project rollup; Layer-2 known-bad overlay (vendored
    OSV snapshot + incident bundles — any hit is Critical); `--sarif` SARIF 2.1.0
    for the GitHub Security tab; `--threshold` controls exit 1.
  - Weights are corpus-gated: generated from the calibration harness separation
    report, provisional until the full top-500 run.

## 0.1.0

### Minor Changes

- 25ffb31: v0.1 — the incident-triage one-liner ships.

  - `lockwarden check <pkg>[@version|@range] [...]` — reports every transitive path by which a package enters the resolved tree, from the lockfile (npm v1/v2/v3, yarn classic, yarn berry, pnpm 6/9), never from package.json.
  - `check --incident <id>` — vendored IOC bundles (axios-mar26, node-ipc-may26, shai-hulud-jun26 seeds).
  - `check <pkg> --history` — exposure windows derived locally from git history of the lockfile.
  - `--json`, `--ci`, `--dir`, `--offline`; exit codes 0/1/2 are the API.
  - Local-first: zero telemetry, zero accounts; 3 runtime dependencies, 0 transitive.
