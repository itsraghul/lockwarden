# JOURNAL.md — build progression

## 2026-07-08 — bun.lock parser (changeset staged, PR pending)

Backlog item: fourth lockfile format, opening lockwarden to Bun projects.

- New `lockfile/bun.ts`: parses Bun ≥1.2's textual JSONC lockfile into the
  unified ResolutionGraph. Nesting paths are npm's node_modules layout minus
  the "node_modules/" prefix ("send/debug/ms"), so edge resolution reuses the
  walk-up algorithm — scope-aware ("@scope/name" is one path segment).
- JSONC handled by a ~60-line in-repo stripper (trailing commas + comments,
  string-safe) — zero new dependencies, per the budget ledger.
- Workspace stubs ("name@workspace:path") skipped with a warning, same
  precedent as npm's link stubs. Root edges from the "" workspace (manifest
  fallback). Git/tarball tuples parsed structurally (meta = first object,
  integrity = last sha string) so odd shapes degrade instead of crash.
- A lone binary bun.lockb → exit 2 with the `--save-text-lockfile` hint.
- Fixture `bun-basic` is real `bun install` output (send's nested debug@2.6.9
  + ms@2.0.0 under hoisted debug@4.4.3/ms@2.1.3 — genuine conflict nesting).
  Tests 339 → 348. Verified live: `audit` (22 pkgs, grade A) and `check ms`
  (both versions, correct transitive paths) against the fixture.
- Docs: supported-lockfile mentions updated across README/site/ARCHITECTURE/
  THREAT-MODEL/CLAUDE.md; CI-recipe path globs gain `**/bun.lock`; check's
  json-output `lockfile.type` enum corrected (it always emitted
  yarn-classic/yarn-berry, never "yarn"). Changeset minor.

## 2026-07-08 — `explain` command (changeset staged, PR pending)

Backlog item after `incidents`: the reference command for finding codes.

- New `lockwarden explain [code]`: no arg lists all 11 families with their
  weights; with a code, prints detects / why-it-matters / what-to-do plus
  corpus-elevation notes. Accepts family ids (LW001), full absolute/delta
  codes, D-shorthand, analyzer ids, and Layer-2 codes — a full dynamic code
  (LW2-IOC-node-ipc-may26) also resolves the vendored advisory it points at.
- Content lives in `scoring/explanations.ts`; **severities are never restated
  there** — read live from weights.ts, so explain can never drift from what
  audit scores (same principle as data-derived test expectations).
- Always exit 0; unknown code exit 2 with the valid-token hint. `check
  --incident`'s unknown-id hint pattern extended to explain's.
- Tests 331 → 339 (8 new, weights/advisory expectations derived, no
  snapshots). Docs: command page + sidebar, json-output section, both
  READMEs (CLI README gains a "reference commands" section), CLAUDE.md
  command surface. Changeset minor.

## 2026-07-07 — `incidents` command (changeset staged, PR pending)

Backlog item after scan-baseline: discoverability for `check --incident`.

- New `lockwarden incidents`: lists every vendored bundle (newest first) with
  date, package/file-IOC counts, the ready-to-paste `npx lockwarden check
  --incident <id>` line, and an OSV-snapshot summary header. Always exit 0
  (informational); exit 2 only on execution errors (malformed overlay).
- `LOCKWARDEN_INCIDENT_DIR` overlays marked `[local overlay]` / `"local": true`
  — new `vendoredIncidentIds()` + `osvSnapshotInfo()` accessors in data/.
- Tests 326 → 331, all expectations DERIVED from the vendored data (no
  snapshots — an incident release must never fail its own PR's CI; same rule
  as the advisory-freshness tests).
- `check --incident` unknown-id hint now points at the command. Docs: new
  command page + sidebar entry, json-output section, check page cross-link,
  both READMEs, CLAUDE.md command surface. Changeset minor.

## 2026-07-07 — inaugural OSV refresh SHIPPED (0.6.1) + release-chain hardening

The supervised first run of the weekly pipeline, which surfaced and fixed four
distinct issues before landing:

- **0.6.1 on npm**: refreshed snapshot (6mo window, `advisories: OSV
  2026-07-07`), published via the new merge-then-dispatch route, verified with
  `npx lockwarden@0.6.1 audit`.
- Bot-PR CI runs are held at `action_required` when the chain's triggering
  actor is github-actions[bot]; human-dispatched chains run instantly. The
  Monday cron therefore still needs one manual approval per changed week until
  the owner adds a PR-creation PAT or relaxes the Actions approval policy
  (details + unstick procedure in MEMORY.md).
- biome's 1 MiB maxSize tripped on the refreshed snapshot in required CI —
  snapshot now biome-ignored; refresh gate runs lint too (landed with PR #23).
- **v1 action tag had silently drifted** (stale at 0.5.1 through two releases):
  action-tag.yml's on:push never fires for bot auto-merges. Tag moved to the
  0.6.1 pin by manual dispatch; release.yml now waits for the pin PR merge and
  dispatches action-tag.yml itself (this PR).

## 2026-07-07 — scan baseline suppression (v0.7 changeset staged, PR pending)

The documented follow-up from the 2026-07-05 baseline design: `scan` gets the
same `--baseline` / `--no-baseline` / `--write-baseline` surface as `audit`.

- `applyBaseline` made generic so scan's `root`-carrying package reports pass
  through; `BASELINE_FILENAME` moved to `scoring/baseline.ts` (audit imports it).
- Default path: `<first --dir, else cwd>/.lockwarden-baseline.json` — an
  artifact is not a writable project dir, so the baseline lives with the
  operator's project. `--baseline <path>` for per-artifact baselines.
- Suppressed findings visible everywhere (dimmed `[suppressed]` lines, additive
  `--json` fields, SARIF `suppressions`), exit code from active findings only —
  identical semantics to audit, same never-suppressible classes.
- Tests 320 → 326 (6 new scan integration tests: round-trip, --dir auto-load,
  json/sarif shapes, missing explicit path, contradictory flags). Existing
  snapshots byte-identical.
- Docs: scan command page (new Baseline section), json-output scan table,
  both READMEs. Changeset minor.

## 2026-07-07 — publish routing fix: all npm publishes via release.yml

The first two supervised osv-refresh dispatches failed at `changeset publish`
with npm's E404 auth disguise — even after PR #21 wired `NPM_TOKEN` through.
Root cause found in the registry metadata: the package publishes via **npm
trusted publishing (OIDC) bound to release.yml** (`_npmUser` = GitHub Actions
on every version); npm allows one trusted publisher per package, so no other
workflow can ever publish, and the token secret never worked.

- osv-refresh.yml + incident-bundle.yml: publish step removed; they now
  version → land the commit via the existing auto-merge PR → poll for the
  merge → `gh workflow run release.yml --ref main` (workflow_dispatch is
  exempt from the GITHUB_TOKEN recursion block; `on: push` is not — the
  auto-merged PR #19 provably never fired release.yml).
- release.yml: new `workflow_dispatch` trigger; publish machinery unchanged.
- Incident latency target <15 → <25 min (required checks on critical path).
- MEMORY.md: new trusted-publishing section; publish-first note struck.

**Pending:** merge PR → re-dispatch osv-refresh supervised → verify the full
chain lands 0.6.1 on npm with a fresh snapshot.

## 2026-07-06 — weekly OSV refresh pipeline (PR pending)

Operational-trust release, part 2 of 2. The "refresh before release" seed
note finally becomes machinery.

- scripts/refresh-osv-snapshot.ts: OSV.dev npm MAL subset via the zip64
  reader, published-only window ladder (18→3mo) under a 1.5MB budget,
  keep-list merge, no-op detection. Dry-run against the real 200MB archive:
  6mo window → 5,495 entries @ 1.07MB.
- scripts/validate-osv-snapshot.ts: wrapper shape + keep-list survival +
  audit self-test (plain-crypto-js hit → exit 1 w/ LW2-OSV code).
- osv-refresh.yml: Monday cron + force dispatch, publish-first + auto-merge
  PR (incident-bundle pattern).
- Dry-run findings fixed: three tests hardcoded vendored dates and would
  have broken on every refresh — now derived from the data (see MEMORY.md).
  Full suite green WITH a refreshed snapshot in-tree.
- Ships no data change itself (no changeset); the first supervised
  workflow_dispatch does the inaugural refresh + patch release.

## 2026-07-06 — advisory freshness + zip64 (v0.6 changeset staged, PR pending)

Operational-trust release, part 1 of 2 (part 2 = the weekly OSV refresh
pipeline, which this unblocks).

- OSV snapshot migrated to a `generatedAt`-stamped wrapper; new
  `advisoryFreshness()`; `audit`/`scan` reports carry additive `advisories`
  dates (never ages) + a human freshness line.
- New global `--max-advisory-age <days>` → exit 2 on stale vendored data
  (audit, scan, check --incident only; plain check exempt by design).
- zip64 EOCD support in lib/zip.ts — needed for the OSV all.zip (221,925
  entries) and a real `scan` improvement for >65k-file artifacts; validated
  against the live 200MB archive.
- Tests 296 → 320; snapshots pinned so refresh/incident releases can't churn
  them; `LOCKWARDEN_NOW` test clock (see MEMORY.md).

## 2026-07-06 — Action release automation (PR pending)

The two manual release-completion steps are now CI:

- release.yml: after any publish, syncs `packages/action/action.yml`'s pinned
  CLI version via an auto-merged `action-pin/<version>` PR (incident-bundle
  pattern; main stays protected).
- New action-tag.yml: on any action.yml pin change reaching main, force-moves
  the floating `v1` tag — after verifying the pinned version actually exists
  on npm. workflow_dispatch fallback for manual runs.
- Sequencing note: merge this BEFORE PR #14 (pin 0.3.1→0.5.0) and the v1 tag
  moves itself when #14 lands — no manual `git tag -f v1` ever again.

## 2026-07-06 — TOP-500 corpus run: weights locked (PR pending)

The calibration milestone CLAUDE.md gated everything on since day one.

- Benign set grown 162 → 500 (npm-high-impact topDownload merge), 496 real
  version-bump pairs fetched (~127 MB cache, 0 failures).
- First run: GATE FAIL — exactly one benign delta Critical in 496 bumps:
  bcrypt 6.0.0's node-pre-gyp→prebuildify migration tripped the lifecycle
  changed-body delta. Fixed with a pure-toolchain-migration exemption in
  lifecycle-scripts (introduced hooks still always fire) + 2 new
  tamper-install-script fixtures proving appended payloads still grade F.
- Re-run: **GATE PASS** — 0/496 benign delta Criticals, all 22 malicious F.
  Weights in weights.ts are now LOCKED (header + CLAUDE.md + docs updated);
  run.ts report/weights.json wording graduates automatically at ≥500.
- Patch changeset: the lifecycle exemption ships as an FP fix.

**Pending:** merge PR; monitor size-delta's 9/496 benign delta Highs at the
next re-run (below the gate, recorded in MEMORY.md).

## 2026-07-05 — audit baseline suppression (v0.4 changeset staged, PR pending)

The CI-adoption unblocker: a checked-in `.lockwarden-baseline.json` of reviewed
findings so `--threshold med`/`low` fails only on NEW execution surface.

- `audit --write-baseline` / `--baseline <path>` / `--no-baseline`; auto-loads
  from the audited dir. Version-independent matching (code + name); Layer-2,
  critical, and grade-F delta findings are never suppressible (see MEMORY.md).
- Suppressed findings stay visible everywhere: human `[suppressed]` lines,
  additive `--json` fields (`suppressed`, `suppressedCounts`, `baseline`), SARIF
  `suppressions` property (GitHub shows them as suppressed, not open).
- Exit code computed AFTER filtering; existing snapshots byte-identical (no
  baseline → no new fields). New `scoring/{baseline,fingerprint}.ts`; fixture
  project `audit-baselined`. Tests 270 → 293.
- Docs: site audit page (new Baseline section + real captured output),
  json-output reference, both READMEs.

**Pending:** merge PR → v0.4.0 release.

## 2026-07-05 — native-binary analyzer LW009 (merged, in v0.4)

Ninth analyzer, closing the largest uncovered execution vector: prebuilt
`.node` binaries load native code at require-time with no `binding.gyp` and
possibly no lifecycle script — invisible to LW001/LW002 until now.

- Corpus-first per build order: born in `corpus/src/analyzers/`, calibrated
  (2 new mutations, 4 specs → 20 fixtures, gate PASS with 0/60 benign noise),
  promoted verbatim, weights transcribed (absolute Low / delta Critical).
- Detects: shipped `.node` files (listing scan) + fetcher toolchains
  (prebuild-install, node-pre-gyp, node-gyp-build, prebuildify) in runtime
  deps/scripts. Zero file reads; magic-byte sniff deferred (see MEMORY.md).
- Tests 270 → 273 on this branch; audit-native fixture project; committed
  native-binary tarball triple; existing snapshots byte-identical.
- Self-audit: +3 Low (platform binaries), still exit 0 at `--threshold high`.
- Docs: scoring tables (site + docs/SCORING.md), audit page, json-output
  analyzer enum, READMEs, CLAUDE.md summary.

**Pending:** merged to main; ships in v0.4.0 with the audit-baseline PR.

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
