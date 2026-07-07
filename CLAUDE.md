# CLAUDE.md — lockwarden

## What this project is

**lockwarden** is a free, open-source, local-first CLI that audits what an npm dependency tree can *execute* — lifecycle install scripts, native build hooks (`binding.gyp`/node-gyp), AI-agent hooks, IDE task files — and answers "am I hit?" during supply-chain incidents. It is a project-scoped lockfile/artifact auditor: not a device scanner, not a registry proxy, not a hosted platform.

One-sentence differentiation vs Socket/Snyk/StepSecurity/npm-audit: **they ask "is this package known-bad?" — lockwarden asks "what can this tree execute, and what changed?"**

Public technical docs live in `docs/` (`ARCHITECTURE.md`, `THREAT-MODEL.md`, `SCORING.md`, `CONTRIBUTING.md`) — read `ARCHITECTURE.md` before implementing any command. The original internal planning/strategy docs (competitive positioning, distribution thesis, kill criteria, naming record) were pulled out of the public repo on 05 Jul 2026 and preserved privately at `~/.claude/plans/lockwarden-internal-strategy.md`; consult it for the "why", not the public docs.

## Project memory & journal — read first, keep current

- **`MEMORY.md`** (repo root) — durable decisions and constraints not derivable from code (naming/registry facts, toolchain gotchas, dependency-budget ledger, calibration decisions, accounts). **Read it at session start.** Add a dated entry whenever a non-obvious decision lands; never delete — strike through and annotate if superseded.
- **`JOURNAL.md`** (repo root) — release-notes-style progression log, newest first. **Append an entry at the end of every work session and every release:** what's new, what changed/was fixed, what's pending. One entry per session/release; keep it scannable.
- Division of labor: JOURNAL = timeline ("what happened"), MEMORY = decisions ("what we must remember"). Spec/docs stay authoritative for product scope; these two files never restate them.

## Hard rules — never violate, never re-litigate

1. **Local-first, zero telemetry, zero accounts.** No analytics, no phone-home, no API backend — ever. Advisory data ships vendored in the npm package; updates happen via npm releases.
2. **Lockfile is the source of truth.** All resolution comes from `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`, never from `package.json` alone. Transitive resolutions must always be reported.
3. **Delta over absolute.** Scoring weights *newly appeared* execution surface between versions above mere existence. Legitimate native packages carry `binding.gyp` forever; attacks introduce it.
4. **Structural detection primary, feeds secondary.** Layer-1 (execution surface + version anomalies) must work with zero network and zero advisory data. Layer-2 (OSV/IOC matching) is an overlay; any Layer-2 hit = Critical.
5. **Network calls are allowed ONLY for:** fetching package tarballs during `--diff`/`--deep` delta comparison. `--offline` must hard-fail (exit 2) on ANY attempted network call.
6. **Provenance is informational, never a pass signal.** Valid SLSA provenance has shipped from compromised pipelines (Miasma, Jun 2026).
7. **Detection, not enforcement.** lockwarden never blocks installs, never proxies the registry.
8. **Dependency budget: <10 total transitive dependencies** for the CLI package. We are a supply-chain security tool; our own tree is a marketing artifact. Run `lockwarden audit` on ourselves in CI once it exists.
9. **Exit codes are the API:** `0` clean, `1` findings at/above `--threshold` (default: high), `2` execution error. Every command must be CI-composable.
10. **No pre-commit/husky hook integrations.** A security tool installing install-time hooks is off-brand.

## Stack & conventions

- TypeScript, Node 20+, ESM only. pnpm workspaces monorepo.
- CLI framework: `commander`. Bundler: `tsup` → single JS output (fast `npx` cold start matters).
- Tests: `vitest`. Fixtures are real package tarballs in `packages/cli/test/fixtures/` — tests must run fully offline.
- Releases: `changesets` → GitHub Actions → `npm publish --provenance`.
- **Publish hygiene:** every package MUST declare an explicit `"files"` allowlist in package.json. Before any publish, run `npm publish --dry-run` and review the tarball contents list — nothing unexplained ships, ever (0.0.1 accidentally included a stray zip; never again). npm publishes require interactive 2FA web-auth locally; CI releases use npm **trusted publishing (OIDC) bound to release.yml** — the only workflow that can publish (one trusted publisher per package; other workflows dispatch release.yml, never `changeset publish` directly — see MEMORY.md 2026-07-07).
- Names: npm `lockwarden`, GitHub `itsraghul/lockwarden`, Action ref `itsraghul/lockwarden/packages/action@v1`. No `lock-warden` alias package: npm's similar-name rule (verified 03 Jul 2026 — E403 "Package name too similar to existing package lockwarden") blocks ANYONE from publishing `lock-warden` while `lockwarden` exists, so the typo variant is registry-protected for free. Do not retry publishing an alias.
- **GitHub account guard:** this is a personal project — all `gh`/git operations MUST use the `itsraghul` account. Before any `gh` command that creates, pushes, or publishes (repo create, PR, release, secrets), run `gh auth status` and verify the **active** account is `itsraghul`. If another account is active, run `gh auth switch --user itsraghul` first (or `gh auth login` if missing). Also verify `git config user.email` matches the itsraghul identity before the first commit. Never create repos, releases, or push commits under any other account.

## Repo layout

```
packages/
  cli/
    src/
      commands/     # audit, check, drift, scan, secrets
      analyzers/    # lifecycle-scripts, binding-gyp, agent-hooks, ide-tasks,
                    # size-delta, obfuscation, phantom-deps, native-binary
      lockfile/     # npm/yarn/pnpm parsers -> unified resolution model
      scoring/      # layer1 + layer2, grades A-F, SARIF 2.1.0 mapper
      data/         # vendored OSV snapshot + incident IOC bundles (JSON)
    test/fixtures/
  action/           # thin GitHub Action wrapper (node20)
site/               # Astro Starlight (landing + versioned docs) — BUILD LAST
corpus/             # calibration harness: NOT shipped, gates all analyzer weights
.github/workflows/  # ci.yml, release.yml, incident-bundle.yml
```

## Scoring model (summary — full table in spec §3)

Layer 1 per-package signals, each with (absolute, delta) weights:
lifecycle script (Low-Med, **Critical**) · binding.gyp (Low, **Critical**) · AI-agent hook/MCP manifest (Med, **Critical**) · IDE task file (Med, **High**) · main-file size >5x vs prev version (—, **High**) · new transitive dep in a patch release (—, **High**) · obfuscation markers in install-path files (Med, **High**) · phantom dependency (Med, —) · prebuilt native binary `.node`/fetcher (Low, **Critical**).

Grades A–F per package; project rollup = worst grade + counts. SARIF: Critical→error, High→warning, Med→note, Low→suppressed.

**Weights are LOCKED by the top-500 corpus run (2026-07-06, gate PASS: 0 benign delta Criticals across 496 real version bumps; all 22 synthetic fixtures modeled on the 2026 malicious set grade F). Any weight or analyzer-behavior change requires re-running `pnpm corpus:run` and a passing gate — weights.ts is transcribed from corpus/report/weights.json, never hand-edited.**

## Build order (do not reorder without explicit approval)

1. Scaffold: monorepo, tsconfig, tsup, vitest, CI skeleton.
2. `corpus/` harness — analyzers get written HERE first, against real tarballs; then promoted into `src/analyzers/`. This gates everything.
3. `lockfile/` parsers → unified resolution model (heaviest test coverage).
4. `check` command (+ `--incident`, `--history`) → **ship v0.1 to npm**. A working triage one-liner alone is launchable.
5. `audit` (+ `--diff` delta scoring) + scoring + SARIF → v0.2.
6. GitHub Action wrapper.
7. `drift`, then `scan` (tarball + docker-save layers), then `secrets` (minimal). v0.3–0.5.
8. `incident-bundle.yml` automation: one command from "new IOC JSON" to published npm patch release.
9. Site (Starlight) — only after the CLI has real users. README is the landing page until then.

## Command surface (implement exactly as specced)

```
lockwarden audit  [--dir <path>] [--diff <base-ref>] [--deep]
lockwarden check  <pkg>@<ver> [...] | --incident <id> | <pkg> --history
lockwarden drift  [--base <ref>]
lockwarden scan   <artifact-path> | --image <docker-image>
lockwarden secrets [--dir <path>]
Global: --json --sarif --ci --dir --threshold <grade> --offline
```

Key semantics: `check` reports every transitive path by which a package enters the tree; `check --history` walks git log of the lockfile to report exposure windows; `audit --diff` fetches previous tarballs ONLY for packages whose resolved version changed; `--deep` is the explicitly-slow full-tree variant.

## Definition of done (per command)

- Works offline except documented tarball fetches; `--offline` verified by a test that fails on any network attempt.
- `--json` and `--sarif` outputs stable and snapshot-tested.
- Exit codes correct under: clean tree, findings below threshold, findings at threshold, parse error.
- Fixture coverage: at least one benign and one malicious-pattern fixture per analyzer.
- Runs green on the monorepo itself.
