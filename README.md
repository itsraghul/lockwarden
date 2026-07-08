<div align="center">

# lockwarden

[![npm](https://img.shields.io/npm/v/lockwarden.svg)](https://www.npmjs.com/package/lockwarden)
[![CI](https://github.com/itsraghul/lockwarden/actions/workflows/ci.yml/badge.svg)](https://github.com/itsraghul/lockwarden/actions/workflows/ci.yml)
[![npm provenance](https://img.shields.io/badge/npm-provenance-blue)](https://www.npmjs.com/package/lockwarden#provenance)
[![license](https://img.shields.io/npm/l/lockwarden.svg)](LICENSE)

**Audit what your npm dependency tree can _execute_ — and answer _"am I hit?"_ in seconds during supply-chain incidents.**

Everyone else asks *"is this package known-bad?"* — lockwarden asks **"what can this tree execute, and what changed?"**

[**lockwarden.dev**](https://lockwarden.dev) · [Docs](https://lockwarden.dev) · [npm](https://www.npmjs.com/package/lockwarden) · [Threat model](docs/THREAT-MODEL.md) · [Architecture](docs/ARCHITECTURE.md)

</div>

---

Modern npm attacks run when you **install or build** a dependency — before a line
of your own code executes — via lifecycle scripts, native build hooks
(`binding.gyp`), AI-agent hooks, IDE task files, or code pre-baked into vendored
`node_modules`. Traditional scanners ask whether a package has a *reported*
vulnerability; they never look at execution surface. lockwarden enumerates that
surface from your **lockfile** and from the artifacts actually on disk, scores what
**changed** between versions, and gives you a CI-composable exit code.

- 🔒 **Local-first** — zero telemetry, zero accounts, no backend, ever. Nothing leaves your machine.
- 🎯 **Lockfile is the truth** — resolves `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`, never `package.json` alone.
- ⚡ **Day-zero capable** — structural + delta detection needs no advisory feed.
- 🧩 **3 runtime dependencies, zero transitive** — a supply-chain tool's own tree is a marketing artifact.
- ✅ **Published with provenance** — SLSA attestation on every release.

## Quick start

```bash
# No install — incident day, "am I hit?"
npx lockwarden check node-ipc@9.1.6
npx lockwarden check --incident shai-hulud-jun26

# Audit the execution surface of your installed tree
npx lockwarden audit

# Were we ever exposed? Exposure windows from local git history
npx lockwarden check axios --history
```

Exit codes are the API: **`0`** clean · **`1`** findings at/above threshold · **`2`** error.

## Commands

| Command | Purpose |
|---|---|
| [`check`](https://lockwarden.dev/commands/check/) | Incident triage — every transitive path a package enters by; `--incident <id>` bundles; `--history` exposure windows. |
| [`audit`](https://lockwarden.dev/commands/audit/) | Execution-surface scoring of the installed tree; `--diff <ref>` delta-scores a PR; `--deep` the whole tree; a checked-in [baseline](https://lockwarden.dev/commands/audit/#baseline) suppresses reviewed findings. |
| [`drift`](https://lockwarden.dev/commands/drift/) | Lockfile tampering vs a base ref — integrity swaps, unexplained bumps, URL moves, patch-introduced deps. |
| [`scan`](https://lockwarden.dev/commands/scan/) | Same analysis on an artifact on disk — tarball, zip, dir, or `docker save` layers; supports the same [baseline](https://lockwarden.dev/commands/scan/#baseline) as `audit`. |
| [`secrets`](https://lockwarden.dev/commands/secrets/) | Minimal hardcoded-credential scan, always masked. |
| [`incidents`](https://lockwarden.dev/commands/incidents/) | List the incident bundles this build knows — the valid `check --incident` ids. |
| [`explain`](https://lockwarden.dev/commands/explain/) | Explain a finding code — what it detects, its weights, what to do. |

Global flags: `--json` · `--sarif` (GitHub Security tab) · `--ci` · `--dir` · `--threshold <grade>` · `--offline` (hard-fails on any network call) · `--max-advisory-age <days>` (exit 2 on stale vendored advisory data).

## GitHub Action

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
        with: { fetch-depth: 0 }
      - uses: itsraghul/lockwarden/packages/action@v1
        with:
          diff-base: ${{ github.event.pull_request.base.sha }}
```

Delta-scores only the packages a PR changed — seconds, low-noise, findings in the
Security tab. See the [Action docs](https://lockwarden.dev/github-action/).

## How it works

```
lockfile ─▶ resolution graph ─▶ analyzers ─▶ signals ─▶ scoring ─▶ report
(npm/yarn/pnpm)  (unified model)  (8 structural) (facts)  (L1 + L2)  (grades · SARIF · exit code)
```

Structural **Layer 1** signals each carry an *absolute* weight and a heavier
*delta* weight for execution surface that newly appeared in a version — because
attacks *introduce* surface (a new `postinstall`, an added `binding.gyp`, a 25×
size jump) while legitimate native packages carry it forever. A **Layer 2** overlay
matches resolved versions against a vendored OSV snapshot and incident bundles.
Weights are calibrated against a corpus of benign and synthetic-malicious packages.

Deep dives: [Threat model](docs/THREAT-MODEL.md) · [Scoring](docs/SCORING.md) · [Architecture](docs/ARCHITECTURE.md).

## Contributing

Issues and PRs welcome. `main` is protected; changes land via branch → PR → green
CI. Read [CONTRIBUTING.md](docs/CONTRIBUTING.md) and [ARCHITECTURE.md](docs/ARCHITECTURE.md)
first — note the firm rules (local-first, lockfile-as-truth, the <10 dependency
budget, exit codes as the API).

```bash
pnpm install && pnpm build && pnpm test    # Node 22+ for dev; the CLI ships for Node 20.12+
```

## Repo layout

```
packages/cli/     the lockwarden npm package (commands, analyzers, lockfile parsers, scoring)
packages/action/  thin GitHub Action wrapper
corpus/           calibration harness — gates all scoring weights (not shipped)
site/             Astro Starlight docs → lockwarden.dev
docs/             architecture, threat model, scoring, contributing
```

## License

[MIT](LICENSE) © Raghul
