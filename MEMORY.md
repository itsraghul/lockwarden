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
- Weights stay provisional until the benign set grows to the full top-500.

## Environment / accounts

- Repo-local git identity is `58110802+itsraghul@users.noreply.github.com`; the
  machine default is the raghul-velt work account. npm publish account:
  `raghul2521`. Both verified 2026-07-03.
- `LOCKWARDEN_REGISTRY` and `LOCKWARDEN_INCIDENT_DIR` env vars exist for
  testability/self-hosted registries — they are not, and must never become,
  telemetry or config surface.
