# JOURNAL.md — build progression

> Release-notes-style log of what shipped and when, newest first. CLAUDE.md points
> here: append an entry per work session / release. Keep entries scannable —
> what's new, what changed, what's pending. Durable decisions go to
> [MEMORY.md](MEMORY.md); this file is the timeline.

## 2026-07-04 — v0.2.0 shipped 🚀 via the automated release loop

First fully-automated release: changeset → Version Packages PR → merge → CI
publish through **npm Trusted Publishing (OIDC)** — no token, no 2FA, and the
package carries a **SLSA provenance attestation**. Published `audit` verified
via `npx lockwarden@0.2.0` (layer-2 fixture grades F, exit 1).

Release-pipeline hardening en route (each fix kills a failure class):
- Repo setting enabled: Actions may create PRs (changesets needs it); default
  workflow token kept read-only
- node20-smoke installs the CLI's pinned dep ranges, not bare latest
  (commander 15 raised its floor to Node 22 → see MEMORY.md)
- biome no longer formats package.json (changesets re-serializes it each bump)

**Pending:** tag `v1` on the Action (after this entry lands), unpublish 0.0.1
(~Jul 6 window), grow corpus to top-500 before declaring weights final.

## 2026-07-03 — audit + scoring + SARIF built (Phase 4 → v0.2)

**New — `lockwarden audit`, the execution-surface wedge:**
- Absolute mode: analyzes what's actually installed in node_modules (hoisted,
  pnpm-store, and nested layouts), zero network — grades A–F per package +
  project rollup
- `--diff <base-ref>`: the PR flow — delta-scores only changed packages,
  fetching previous tarballs from the base lockfile's own resolved URLs
  (SRI-verified, cached `~/.lockwarden/cache`); introduced execution surface
  scores Critical per the corpus-calibrated weights
- `--deep`: full-tree delta vs previous published versions (slow by design)
- Layer-2 known-bad overlay: vendored OSV seed snapshot + incident bundles —
  any hit is Critical/F regardless of Layer 1
- `--sarif` (SARIF 2.1.0, stable fingerprints, Low suppressed unless
  `--verbose`), `--threshold` with grade-letter aliases

**Also:**
- Analyzers PROMOTED corpus → `src/analyzers/` (verbatim, per build order);
  corpus now re-validates the shipped modules via shims; `scoring/weights.ts`
  transcribed from corpus report @25ffb31 with the elevation layer
- GitHub Action wrapper (`packages/action`, Phase 5): composite node22,
  pinned CLI version, SARIF upload via codeql-action — tag `@v1` after 0.2.0
  publishes
- CI self-audit gate: `audit --ci --threshold high` on our own tree (grade C,
  31/320 flagged — all expected med absolutes on build tooling; exit 0)
- Project memory system: MEMORY.md + JOURNAL.md wired into CLAUDE.md
- Tests: 82 → **163** (scoring engine, lockdiff, node_modules locator, audit
  integration incl. cold/warm-cache `--offline` proofs)

**Pending:** publish 0.2.0 (changeset staged), tag action `@v1` after, then
Phase 6 (`drift`, `scan`, `secrets`) → Phase 7 (incident-bundle automation) →
Phase 8 (Starlight site on lockwarden.dev).

## 2026-07-03 — v0.1.0 shipped 🚀 (Phases 0–3)

**Published:** [`lockwarden@0.1.0`](https://www.npmjs.com/package/lockwarden) on npm,
GitHub release `lockwarden@0.1.0`, repo live at github.com/itsraghul/lockwarden.

**New — the incident-triage one-liner (build-order Phase 4 milestone):**
- `lockwarden check <pkg>[@ver|@range] [...]` — every transitive path by which a
  package enters the resolved tree, straight from the lockfile
- `check --incident <id>` — vendored IOC bundles (seeds: axios-mar26,
  node-ipc-may26, shai-hulud-jun26) + `LOCKWARDEN_INCIDENT_DIR` local overlay
- `check <pkg> --history` — exposure windows from local git history of the lockfile
- Globals wired: `--json --ci --dir --offline`; exit codes 0/1/2

**Infrastructure:**
- Lockfile parsers: npm v1/v2/v3, yarn classic (custom), yarn berry, pnpm 6/9 →
  unified `ResolutionGraph`; cycle-safe reverse-DFS path enumeration (cap 500)
- Corpus calibration harness (`corpus/`): 8 analyzers born there; 60 benign
  packages + 16 synthetic defanged malicious fixtures; **separation gate PASS**
  (all malicious F in delta mode, 0 benign delta Criticals)
- Custom tar.gz reader + artifact loader (no `tar` dep); `lib/net.ts` as the sole
  network chokepoint with structural + behavioral offline tests
- 82 tests (unit + integration), biome, tsc strict, changesets, CI + release
  workflows; publish-hygiene tarball gate

**Fixed along the way:**
- CI: pnpm 11 needs Node ≥22.13 → pipeline on 22/24 + `node20-smoke` job for the
  engine floor; tarball gate moved to `npm pack --json` (npm 11 shape change)
- `lock-warden` alias removed: npm E403 similar-name rule already protects the
  typo (see MEMORY.md)

**Pending:** `npm unpublish lockwarden@0.0.1` (stray zip; window ~Jul 6),
`NPM_TOKEN` secret for CI releases with provenance.

## 2026-07-03 — project bootstrapped

Spec + use-case docs written; plan approved (corpus-first build order); monorepo
scaffolded (pnpm workspaces, tsup single-bundle, vitest projects, biome,
changesets). npm name claimed at 0.0.1, GitHub repo created, `lockwarden.dev`
registered.
