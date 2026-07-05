# Architecture

How lockwarden is built, for contributors. For the security rationale see
[THREAT-MODEL.md](THREAT-MODEL.md); for the scoring rules see [SCORING.md](SCORING.md).

## Pipeline

```
lockfile ──▶ resolution graph ──▶ analyzers ──▶ signals ──▶ scoring ──▶ report
(npm/yarn/pnpm)   (unified model)  (8 structural)  (facts)   (L1 + L2)   (grades, SARIF, exit code)
```

1. **Parse** the lockfile (`src/lockfile/`) into one unified `ResolutionGraph` —
   packages, dependency edges, and a reverse (`inbound`) index. Supported:
   `package-lock.json` v1/v2/v3, `yarn.lock` (classic + berry), `pnpm-lock.yaml`
   6.x/9.x.
2. **Analyze** each package's contents (`src/analyzers/`). Analyzers emit typed
   `Signal` facts — they never assign severity.
3. **Score** (`src/scoring/`). Layer 1 maps `(analyzer, kind)` to a corpus-gated
   weight; Layer 2 overlays known-bad matches. Produces per-package grades and a
   rollup.
4. **Render** as human output, `--json`, or `--sarif`, and exit with the
   threshold-derived code.

## The resolution model

Every parser normalizes to the same graph so the rest of the tool is
lockfile-agnostic. The key insight: each lockfile format keys packages differently
(npm by `node_modules/` path, pnpm by `name@version(peer-hash)`, yarn by
descriptor), so the model normalizes to `name@version` nodes plus explicit edges,
preserving original locators for diagnostics.

`check` answers "every path by which a package enters the tree" with a cycle-safe
reverse DFS over the `inbound` index (capped at 500 paths). `check --history` walks
`git log` of the lockfile and reparses each historical revision to report exposure
windows — entirely from local git.

## The analyzer contract

An analyzer is `{ id, scope, needsPrevious, needsProject, analyze(ctx) → Signal[] }`.
It receives the current package artifact, optionally the previous version (delta
mode), and optionally tree/project context. It returns facts with evidence and raw
`metrics` — the metrics are what the calibration harness tunes cutoffs against.

The eight analyzers: `lifecycle-scripts`, `binding-gyp`, `agent-hooks`,
`ide-tasks`, `size-delta`, `dep-introduction`, `obfuscation`, `phantom-deps`.

**Analyzers are born in `corpus/` and promoted verbatim into
`src/analyzers/`.** After promotion, the corpus re-imports the shipped module so
calibration keeps validating exactly what ships. Never edit weights by hand —
regenerate them (see below).

## Commands

| Command | What it does |
|---|---|
| `check` | Incident triage — resolve queries/incident bundles against the lockfile, report transitive paths and historical exposure. |
| `audit` | Execution-surface scoring of the installed tree. `--diff <ref>` delta-scores only changed packages; `--deep` does the whole tree. |
| `drift` | Lockfile tampering vs a base ref — integrity swaps, unexplained version changes, resolved-URL moves, deps introduced by patch bumps. |
| `scan` | The same analysis applied to an artifact on disk — tarball, zip, directory, or `docker save` layers — catching pre-baked `node_modules` tampering. |
| `secrets` | Minimal hardcoded-credential scan of project source and dependency install paths. |

## The network chokepoint

Network access is allowed for exactly one purpose: fetching previous package
tarballs during `--diff` / `--deep` delta comparison. **Every byte flows through
`src/lib/net.ts`** — the only module permitted to reference `fetch`. A unit test
enforces this structurally, and `--offline` makes `net.ts` throw before any
dispatch (exit 2). This is what lets airgapped CI *prove* the local-first claim.

Fetched tarballs are SRI-verified against the lockfile's integrity hash and cached
in `~/.lockwarden/cache`.

## <a id="corpus"></a>The corpus (calibration harness)

`corpus/` is never shipped. It fetches top-download benign tarballs and generates
synthetic, defanged malicious fixtures (a benign base plus a structural mutation:
injected `postinstall`, added `binding.gyp`, inflated main file, phantom dep, …).
Running every analyzer over both sets produces a separation report and a
`weights.json`. The gate: every malicious fixture grades F in delta mode while
benign version-bumps produce zero Criticals. `src/scoring/weights.ts` is transcribed
from that report and carries the source commit in its header.

## Vendored data

`src/data/` holds the OSV npm-malware snapshot and incident IOC bundles as JSON,
inlined into the single-file build by the bundler. There is no runtime API — the
npm release cadence is the data pipeline. Incident bundles are registered through a
generated index (`scripts/generate-incident-index.ts`) so adding a bundle never
hand-edits source.

## Constraints

- **TypeScript, Node 20+, ESM only.** pnpm workspaces monorepo.
- **Dependency budget: fewer than 10 total transitive runtime dependencies.** The
  CLI currently ships **3** (`commander`, `yaml`, `semver` — each with zero
  transitive deps). A supply-chain security tool's own tree is a marketing
  artifact; tar reading, yarn parsing, SRI verification, and SARIF emission are all
  custom rather than dependencies.
- **Single-file build** (`tsup` → one `dist/index.js`) for fast `npx` cold start.
- **Tests run fully offline** (`vitest`); fixtures are real/synthetic tarballs. An
  `--offline` guarantee test fails on any network attempt.

## Repo layout

```
packages/
  cli/          # the lockwarden npm package
    src/
      commands/   analyzers/   lockfile/   scoring/   data/   lib/
    test/         # unit + integration + fixtures
  action/       # thin GitHub Action wrapper
corpus/         # calibration harness (not shipped)
site/           # Astro Starlight docs → lockwarden.dev
docs/           # this documentation
.github/workflows/   # ci, release, incident-bundle, site
```
