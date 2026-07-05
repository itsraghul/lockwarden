# JOURNAL.md — build progression

## 2026-07-05 — docs site overhaul (12 → 21 pages, PR pending)

lockwarden.dev grew from a skeleton into full open-source docs (~3,400 lines):

- **Guides**: CI recipes (GitHub Actions/GitLab/CircleCI/Jenkins/generic, with
  line-by-line explanations, cache + --offline patterns), incident-response
  runbook, dependency-review (Renovate/Dependabot habit)
- **Commands**: all 5 expanded with real captured output (fixtures + scratch git
  repos + a local HTTP registry for a genuine --diff delta run), full flag
  tables, annotated --json shapes, per-command exit codes
- **Reference**: json-output (complete machine-readable schema + jq recipes),
  exit-codes, expanded scoring/trust-model/incidents
- **Project**: comparison page (Socket/Snyk/StepSecurity/npm audit — positioning
  discipline enforced: states plainly Socket's server-side analysis is deeper;
  differentiates on trust model/vectors/artifacts/triage; "when they're the
  better choice" section) + 11 ADRs in architecture-decisions
- **AI consumability**: llms.txt (curated index) + llms-full.txt GENERATED at
  build from all docs (can't go stale)
- Fixed en route: action.yml CLI pin bumped 0.2.0 → 0.3.1 (release workflow does
  NOT auto-bump it — manual step per release until automated)
- Facts verified against shipped code; weight-table discrepancies resolved in
  favor of weights.ts (CLAUDE.md summary table is approximate)

## 2026-07-05 — public-repo docs refactor

Made the repo docs public-appropriate now that lockwarden.dev is live.

- Removed the two internal planning docs (`docs/lockwarden-v1-spec.md`,
  `docs/lockwarden-use-case-and-learnings.md`) — they held competitive
  positioning, distribution thesis, kill criteria, and naming/trademark
  reasoning. Preserved privately at `~/.claude/plans/lockwarden-internal-strategy.md`
  (git history still contains the originals — not a security scrub).
- New public docs: `docs/{ARCHITECTURE,THREAT-MODEL,SCORING,CONTRIBUTING}.md`
  — contributor- and user-facing, sanitized of business strategy.
- Rewrote both READMEs as proper open-source library docs: badges, quick start,
  full per-command reference, Action snippet, scoring/trust-model summaries,
  contributing, repo layout. The CLI README (npm page) is self-contained.
- Repointed CLAUDE.md and the 3 incident-bundle `references` at the new docs /
  site; package `homepage` → lockwarden.dev.

270 tests still green; changeset staged (patch — bundled data + homepage change).

## 2026-07-04 — v1 command surface complete + site (Phases 6–8, PR pending)

**New commands (v0.3 changeset staged):**
- `drift [--base <ref>]` — lockfile tampering: integrity swaps (Critical),
  unexplained version changes, resolved-URL host moves, patch/minor-introduced
  packages; provenance strictly informational
- `scan <artifact> | --image` — what's ACTUALLY on disk: vendored node_modules
  in tarballs/zips/dirs/docker-save layers (later-layer-wins + whiteouts),
  incident fileIocs sha256 matching, fully offline
- `secrets` — 15 curated rules + entropy, dependency install-path scanning,
  always-masked output

**Automation (Phase 7):** incident-bundle.yml — one dispatch: validate IOC JSON
→ self-test (hit exits 1 / clean exits 0) → npm patch publish FIRST → version
commit lands via auto-merge PR. incidents/index.ts is now generated
(scripts/generate-incident-index.ts) so bundles never hand-edit source.

**Site (Phase 8):** Astro Starlight in site/, 12 pages (landing + command docs +
trust model + scoring + incidents), zero external resources, links validated at
build; deploys to GitHub Pages via site.yml with CNAME lockwarden.dev.
Post-merge: enable Pages (Source: GitHub Actions) + point DNS.

**Repo protection:** main now requires PR + green CI (test 22/24, node20-smoke),
no direct pushes for anyone, no force-push/deletion. Auto-merge enabled.

Tests: 163 → **270**. All work on feat/v0.3-drift-scan-secrets → single PR.

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
