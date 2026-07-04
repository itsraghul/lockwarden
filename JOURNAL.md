# JOURNAL.md — build progression

> Release-notes-style log of what shipped and when, newest first. CLAUDE.md points
> here: append an entry per work session / release. Keep entries scannable —
> what's new, what changed, what's pending. Durable decisions go to
> [MEMORY.md](MEMORY.md); this file is the timeline.

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
