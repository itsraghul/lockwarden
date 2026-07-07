# lockwarden

[![npm](https://img.shields.io/npm/v/lockwarden.svg)](https://www.npmjs.com/package/lockwarden)
[![npm provenance](https://img.shields.io/badge/npm-provenance-blue)](https://www.npmjs.com/package/lockwarden#provenance)
[![license](https://img.shields.io/npm/l/lockwarden.svg)](https://github.com/itsraghul/lockwarden/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/lockwarden.svg)](https://nodejs.org)

> **Audit what your npm dependency tree can _execute_ — and answer _"am I hit?"_ in seconds during supply-chain incidents.**

Everyone else asks *"is this package known-bad?"* — lockwarden asks **"what can this tree execute, and what changed?"**

Modern npm attacks run when you **install or build**, before a line of your app executes — via lifecycle scripts, native build hooks (`binding.gyp`), AI-agent hooks, IDE task files, or code pre-baked into vendored `node_modules`. lockwarden enumerates that execution surface from your **lockfile** and the artifacts actually on disk.

- 🔒 **Local-first.** Zero telemetry, zero accounts, no backend. Nothing ever leaves your machine.
- 🎯 **Lockfile is the truth.** Resolves against `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` — where transitive attacks live — never `package.json` alone.
- ⚡ **Day-zero capable.** Structural detection (execution surface + version deltas) needs no advisory feed to fire.
- 🧩 **Tiny by design.** 3 runtime dependencies, zero transitive. A supply-chain tool's own tree is a marketing artifact.

Full docs: **[lockwarden.dev](https://lockwarden.dev)**

## Quick start — no install

```bash
# Incident day: am I hit? Every transitive path, from the resolved lockfile.
npx lockwarden check node-ipc@9.1.6

# Check a whole named incident's package set at once.
npx lockwarden check --incident shai-hulud-jun26

# Were we EVER exposed? Exposure windows derived from local git history.
npx lockwarden check axios --history

# Audit the execution surface of the installed tree.
npx lockwarden audit
```

Exit codes are the API: **`0`** clean · **`1`** findings at/above threshold · **`2`** execution error. Every command is CI-composable.

## Install

```bash
npm i -g lockwarden      # or: pnpm add -g lockwarden / yarn global add lockwarden
```

Requires Node.js **20.12+**. Or just use `npx lockwarden …` with no install.

## Commands

### `check` — incident triage

Report every path by which a package enters the resolved tree.

```bash
lockwarden check <pkg>[@version|@range] [<pkg>@<version> ...]
lockwarden check --incident <id>       # vendored IOC bundle
lockwarden check <pkg> --history       # exposure windows from git
```

```
$ lockwarden check evil-pkg@1.2.3
  HIT  evil-pkg@1.2.3
       project → app-lib@1.0.0 → evil-pkg@1.2.3
       project → other-lib@2.0.0 → nested-lib@3.0.1 → evil-pkg@1.2.3
```

Queries accept exact versions, semver ranges, or a bare name (all resolved
versions). List the bundles your installed version knows with
`lockwarden incidents` (ids, dates, package counts — always exit 0); see
[lockwarden.dev/incidents](https://lockwarden.dev/incidents/) for the catalog.

### `audit` — execution-surface scoring

```bash
lockwarden audit                    # absolute scan of the installed tree (offline)
lockwarden audit --diff <base-ref>  # delta-score only packages that changed vs a git ref
lockwarden audit --deep             # full-tree delta vs previous published versions (slow)
lockwarden audit --write-baseline   # accept current findings into .lockwarden-baseline.json
```

Grades each package **A–F** and rolls up to a project summary. `--diff` is the PR
flow: it fetches previous tarballs only for changed packages (SRI-verified, cached),
and scores what the change *introduced* — the signal every 2026 attack exhibited.

A checked-in [baseline file](https://lockwarden.dev/commands/audit/#baseline) suppresses
*reviewed* findings so CI fails only on new ones; suppressed findings stay visible in
every output, and known-bad or Critical findings can never be baselined.

### `drift` — lockfile tampering detection

```bash
lockwarden drift --base <ref>
```

Flags integrity-hash swaps on unchanged versions (Critical), resolved-URL host
moves, version changes unexplained by `package.json`, and new packages arriving via
patch/minor bumps. Provenance is reported as **informational only** — valid
provenance has shipped from compromised pipelines.

### `scan` — artifact & image scanning

```bash
lockwarden scan <artifact-path>       # tarball, zip, or directory
lockwarden scan --image <docker-image># via `docker save` layers
```

Applies the same analysis to vendored `node_modules` **actually on disk** —
inside tarballs, zips, and Docker layers (later-layer-wins, whiteouts honored) —
catching pre-baked tampering that registry-level scanning never sees. Supports
the same [baseline file](https://lockwarden.dev/commands/scan/#baseline) as
`audit` (`--write-baseline` / `--baseline <path>` / `--no-baseline`).

### `secrets` — hardcoded-credential scan

```bash
lockwarden secrets [--dir <path>]
```

A deliberately minimal regex + entropy scan of project source and dependency
install-path files. Secrets are always masked in every output mode.

## Global flags

| Flag | Effect |
|---|---|
| `--json` | machine-readable JSON output |
| `--sarif` | SARIF 2.1.0 (GitHub Security tab) |
| `--ci` | no colour/spinner, exit codes only |
| `--dir <path>` | project root (repeatable) |
| `--threshold <grade>` | minimum severity that triggers exit `1` (default: `high`) |
| `--offline` | hard-fail on any network call (exit `2`) — proves the local-first claim |
| `--max-advisory-age <days>` | exit `2` when the vendored advisory data is older than `<days>` days |

## GitHub Action

Two lines: execution-surface review on every dependency bump, findings in the
Security tab you already use.

```yaml
# .github/workflows/lockwarden.yml
on:
  pull_request:
    paths: ['**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock']
permissions: { contents: read, security-events: write }
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }        # --diff needs the base ref
      - uses: itsraghul/lockwarden/packages/action@v1
        with:
          diff-base: ${{ github.event.pull_request.base.sha }}
```

## How scoring works

Structural **Layer 1** signals (lifecycle scripts, `binding.gyp`, agent hooks, IDE
tasks, prebuilt `.node` binaries, size deltas, obfuscation, phantom & patch-introduced
deps) each carry an
*absolute* weight and a heavier *delta* weight for surface that newly appeared. A
**Layer 2** overlay matches resolved versions against a vendored OSV snapshot and
incident bundles — any hit is Critical. Weights are calibrated against a corpus of
benign and synthetic-malicious packages. Details: [Scoring](https://lockwarden.dev/scoring/).

## Trust model

Advisory data ships **vendored** in this package and updates via npm releases — the
release cadence *is* the data pipeline. There is no runtime API to block or
distrust. The only network calls lockwarden ever makes are registry tarball fetches
during `--diff` / `--deep`, all routed through a single module that `--offline`
short-circuits. More: [Trust model](https://lockwarden.dev/trust-model/).

## Links

- **Docs:** [lockwarden.dev](https://lockwarden.dev)
- **Source & issues:** [github.com/itsraghul/lockwarden](https://github.com/itsraghul/lockwarden)
- **Threat model** · **Architecture** · **Contributing:** in the repo's [`docs/`](https://github.com/itsraghul/lockwarden/tree/main/docs)

## License

[MIT](https://github.com/itsraghul/lockwarden/blob/main/LICENSE) © Raghul
