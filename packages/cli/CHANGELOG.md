# lockwarden

## 0.1.0

### Minor Changes

- 25ffb31: v0.1 — the incident-triage one-liner ships.

  - `lockwarden check <pkg>[@version|@range] [...]` — reports every transitive path by which a package enters the resolved tree, from the lockfile (npm v1/v2/v3, yarn classic, yarn berry, pnpm 6/9), never from package.json.
  - `check --incident <id>` — vendored IOC bundles (axios-mar26, node-ipc-may26, shai-hulud-jun26 seeds).
  - `check <pkg> --history` — exposure windows derived locally from git history of the lockfile.
  - `--json`, `--ci`, `--dir`, `--offline`; exit codes 0/1/2 are the API.
  - Local-first: zero telemetry, zero accounts; 3 runtime dependencies, 0 transitive.
