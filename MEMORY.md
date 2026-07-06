# MEMORY.md — durable project decisions

> In-repo project memory. CLAUDE.md points here: read this at session start; add a
> dated entry whenever a decision is made that isn't derivable from code or the
> spec docs. Never delete entries — strike through and annotate if superseded.
> Progression/what-shipped lives in [JOURNAL.md](JOURNAL.md), not here.

## Naming & registry

- **2026-07-03 — No `lock-warden` alias package, ever.** npm's similar-name rule
  returns E403 ("too similar to lockwarden") for ANY publisher while `lockwarden`
  exists — the typo variant is registry-protected for free. An alias package was
  built and removed same-day (`813539c`) because CI `changeset publish` would
  retry the 403 forever. Also in CLAUDE.md conventions.
- **2026-07-03 — `lockwarden.dev` registered** (GoDaddy). Reserved for the Phase 8
  Starlight site on GitHub Pages. `.dev` is HSTS-preloaded (HTTPS mandatory), so
  GoDaddy's plain forwarding can't serve an interim redirect — use Cloudflare free
  tier if a redirect is wanted before the site ships. On site launch: swap repo
  homepage + packages/cli `homepage` from the npm URL to https://lockwarden.dev.

## Toolchain constraints

- **2026-07-03 — pnpm 11 requires Node ≥ 22.13** (`node:sqlite`). CI pipeline runs
  on Node 22/24; the CLI's Node 20.12 engine floor is proven by the pnpm-free
  `node20-smoke` CI job that runs the built artifact against fixtures. Don't
  re-add Node 20 to the pnpm-based matrix.
- **2026-07-04 — commander must stay on ^13 while the Node 20.12 engine floor
  stands.** commander 15 (and 14) require Node ≥22; bumping it would silently
  break the floor. The node20-smoke CI job installs the exact ranges from
  packages/cli/package.json (not bare latest) and exists to catch precisely
  this class of drift. Revisit when the engine floor moves to 22.
- **2026-07-03 — Tarball gate parses `npm pack --dry-run --json`** (stable array
  shape across npm majors). `npm publish --dry-run --json` changed shape in npm 11
  and broke CI. Local interactive publishes still use `npm publish --dry-run` for
  eyeball review.

## Dependency budget ledger (hard cap <10 transitive, CLAUDE.md rule 8)

- Spent: **3** — commander, yaml, semver (each 0 transitive). Headroom of 7 is
  reserved, not spendable casually. Custom in-repo instead of deps: tar.gz reader
  (`lib/tar.ts`), yarn-v1 parser, SRI verify, SARIF writer, colors (`styleText`).

## Calibration decisions (corpus run 2026-07-03, 60 benign + 16 synthetic)

- Lifecycle **delta** signal restricted to preinstall/install/postinstall —
  `prepare` doesn't run on consumer installs of registry deps and produced a
  false Critical (uuid's husky→lefthook swap). `prepare` still signals absolute.
- agent-hooks requires executable surface (MCP manifest / `mcpServers` /
  hooks / `SessionStart`), not bare `.claude/` file presence (`resolve` ships a
  leaked `.claude/notes.md`).
- Three delta shapes elevated spec-§3 High → Critical (verified zero benign
  cost): ide-task folderOpen delta; size-delta + obfuscation co-occurrence;
  dep-introduction patch-smuggle. Recorded in corpus/report/weights.json — that
  file is the ONLY legitimate source for scoring/weights.ts.
- ~~Weights stay provisional until the benign set grows to the full top-500.~~
  Superseded 2026-07-06: the top-500 run passed — see the section below.

## Calibration — TOP-500 run (2026-07-06): weights LOCKED

- **Gate PASS at full scale**: 500 benign (496 real version-bump pairs) + 22
  synthetic malicious. 0 benign delta Criticals; all malicious F. Weights in
  scoring/weights.ts are no longer provisional; any change now requires a
  corpus re-run (CLAUDE.md updated accordingly).
- **Benign set provenance**: the ~162-package curated v1 core grown to 500
  with `npm-high-impact@1.13.0`'s `topDownload` list, assembled offline into
  benign-top500.json (fetch-benign.ts stays the only network-touching corpus
  script). Cache is ~127 MB, gitignored, idempotent to refetch.
- **One FP found and fixed**: bcrypt 5.1.1→6.0.0 swapped
  `node-pre-gyp install --fallback-to-build` → `node-gyp-build` and tripped the
  lifecycle CHANGED-body delta. Fix: changed-body delta is exempt when BOTH old
  and new bodies are pure native-toolchain invocations (node-gyp, node-gyp-build,
  node-pre-gyp, prebuild-install, prebuildify, cmake-js + plain args only — no
  paths/URLs/metachars). Freshly INTRODUCED hooks always signal. Two new
  `tamper-install-script` fixtures (bcrypt, esbuild) prove an appended payload
  (`… && node lw-inert.js`) on those exact scripts still grades F — same
  philosophy as the uuid/`prepare` exemption from calibration v1.
- **Known accepted noise** (below the gate, monitor at next re-run):
  size-delta 9/496 benign delta Highs (grade D on a bump; none co-fired
  obfuscation so no elevation); phantom-deps 2/496 benign deltas (by design,
  never elevated); lifecycle absolute 64/500, phantom absolute 34/500,
  native-binary absolute 7/500 — all expected inventory-level signals.

## Baseline suppression design (2026-07-05)

- **First (and only) config-file surface**: `.lockwarden-baseline.json`, audit-only
  for now. Deliberate precedent — hand-rolled validation, zero new deps, pure disk
  (works under `--offline`). `scan` extension is a documented follow-up (it reuses
  `AuditReport`, so the same `applyBaseline` slots in).
- **Matching is version-independent** (`code` + package `name`, no version): accepted
  absolute surface persists across benign bumps (the esbuild-lifecycle case); what
  CHANGES between versions is the delta analyzers' + Layer-2's job, which a baseline
  can never mute. SARIF's per-result fingerprint stays version-inclusive — different
  purpose (GitHub result tracking), shared code in `scoring/fingerprint.ts`.
- **Never suppressible**: Layer-2, critical severity, and delta findings on grade-F
  packages. The F-guard exists because `elevateSeverity` can compound two Highs into
  a Critical (node-ipc shape) — suppressing the Highs would silently dissolve it.
  Consequence: suppression never lowers an F, and `regrade()` hard-codes that.
- Do NOT commit a baseline at the repo root — the self-audit's clean-tree posture is
  a marketing artifact (CLAUDE.md rule 8 spirit).

## native-binary analyzer decisions (2026-07-05)

- **LW009 weights: absolute Low / delta Critical**, corpus-gated 2026-07-05
  (60 benign + 20 synthetic, gate PASS, 0/60 benign absolute AND delta noise —
  no cached benign ships a `.node` in either version; expect the absolute rate
  to jump when the corpus grows to top-500 with sharp/esbuild platform pkgs,
  which is fine: only delta gates).
- **Magic-byte sniffing of `.node` entries deliberately deferred** — v1 is
  listing+manifest only (zero file reads, binding-gyp cost profile). Sniffing
  would force decoding potentially multi-MB tar entries in `--deep` and
  synthetic fixtures would need fake ELF headers; revisit only if calibration
  shows text files masquerading as `.node` matter.
- Fetcher-token overlap is accepted: `install: prebuild-install || node-gyp
  rebuild` trips LW001 + LW002 + LW009 — all true facts, corroborating (same
  philosophy as phantom-dep + dropper co-firing).
- Self-audit impact on the monorepo: +3 Low (fsevents/rollup/sharp platform
  binaries on darwin; linux variants on CI), grade B each — `--ci --threshold
  high` stays exit 0.

## Repo protection (2026-07-04)

- `main` is protected by ruleset `protect-main` (id 18502842): PR required
  (0 approvals — solo repo, you can't approve your own PR), required checks
  `test (22)` / `test (24)` / `node20-smoke`, no force-push, no deletion,
  **no bypass actors — direct pushes are rejected for everyone, including the
  owner and workflows**. All work lands via branch → PR → green CI → merge.
- Consequences wired in: incident-bundle.yml publishes to npm FIRST, then lands
  its version commit via `gh pr merge --auto --squash` (repo has auto-merge +
  delete-branch-on-merge enabled). The changesets Version Packages flow is
  unaffected (it was already PR-based). If a CI job is renamed, update the
  ruleset's required checks or merges will deadlock.

## Environment / accounts

- Repo-local git identity is `58110802+itsraghul@users.noreply.github.com`; the
  machine default is the raghul-velt work account. npm publish account:
  `raghul2521`. Both verified 2026-07-03.
- `LOCKWARDEN_REGISTRY` and `LOCKWARDEN_INCIDENT_DIR` env vars exist for
  testability/self-hosted registries — they are not, and must never become,
  telemetry or config surface.
