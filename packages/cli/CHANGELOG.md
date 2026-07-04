# lockwarden

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
