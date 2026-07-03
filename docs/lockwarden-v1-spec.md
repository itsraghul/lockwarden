# Lockwarden — v1 Specification

**One-liner:** A local-first CLI that audits what your npm dependency tree can *execute* — install scripts, native build hooks, AI-agent hooks, IDE task files — and answers "am I hit?" in seconds during supply-chain incidents.

**Positioning:** Project-scoped lockfile/artifact auditor. Not a device scanner (Dev Machine Guard), not a registry proxy (Secure Registry), not a hosted platform (Socket, Snyk). Zero account, zero telemetry, `npx` as the front door.

---

## 1. Design principles

1. **Local-first, no phone-home.** All analysis runs locally. Signature/advisory data ships vendored in the package and updates via npm releases. No API endpoint exists for malware to block or for users to distrust.
2. **Structural detection first, feeds second.** Primary detection is execution-surface analysis and version-delta anomalies — works on day zero without any advisory having been published. Known-bad matching (OSV, incident IOC bundles) is the secondary overlay.
3. **Delta over absolute.** Legitimate native packages carry `binding.gyp` forever; attacks *introduce* it. Score what changed between versions, not what exists.
4. **Lockfile is the source of truth.** Always resolve against `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`, never `package.json` alone. Transitive resolutions are where 2026 attacks lived (Axios → plain-crypto-js).
5. **Exit codes are the API.** Every command is CI-composable: `0` clean, `1` findings at/above threshold, `2` execution error.

## 2. Command surface

```
npx lockwarden <command> [flags]
```

### 2.1 `audit` — execution surface audit (the wedge)

```
npx lockwarden audit [--dir <path>] [--diff <base-ref>] [--deep]
```

Enumerates every execution vector in the resolved dependency tree:

- npm lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare`)
- `binding.gyp` / node-gyp build hooks
- AI-agent hook files (Claude/Cursor/Copilot config, `SessionStart` hooks, MCP server manifests inside packages)
- IDE task files (`.vscode/tasks.json`, folder-open tasks) shipped inside packages
- Phantom dependencies (in manifest, never imported in source)
- Obfuscation markers in install-path files (eval chains, hex arrays, packed strings)
- Main-file size anomalies vs previous version (>5x flag)

**Modes:**
- Default: full-tree absolute scan (Layer-1 absolute weights only — no network).
- `--diff <base-ref>`: compares lockfile against a git ref; computes **delta scores** only for packages whose resolved version changed. This is the PR/CI hero flow — network fetches limited to changed packages' previous tarballs.
- `--deep`: full-tree delta scan (fetches previous version of every dep). Explicitly slow; for periodic scheduled runs, not PRs.

> **Decision (latency question resolved):** v1 ships delta scoring scoped to the lockfile diff (`--diff`). Full-tree deltas exist behind `--deep`. A precomputed metadata index is a post-v1 optimization, only if `--deep` demand materializes.

### 2.2 `check` — incident triage one-liner

```
npx lockwarden check <pkg>@<version> [<pkg>@<version> ...]
npx lockwarden check --incident <incident-id>
npx lockwarden check <pkg> --history
```

- Resolves the query against the lockfile including **all transitive resolutions**; reports every path by which the package enters the tree.
- `--incident <id>`: vendored, named IOC bundles (e.g. `axios-mar26`, `node-ipc-may26`, `shai-hulud-jun26`) — package+version lists shipped via patch releases within hours of major incidents. **This is the distribution mechanism:** the one-liner posted in HN/Reddit/Slack threads on incident day.
- `--history`: walks `git log` of the lockfile to answer "was I *ever* exposed, and during which commit window?" — the historical-exposure feature incumbents gate behind enterprise pricing, derived locally from git.

### 2.3 `drift` — lockfile & version-anomaly detection

```
npx lockwarden drift [--base <ref>]
```

Compares current lockfile against a base ref and flags:

- Resolved version changes not explained by `package.json` changes (lockfile-only tampering)
- Registry/tarball URL changes (resolved integrity hash source moved)
- Integrity hash changes for an unchanged version
- New packages entering via patch/minor bumps of existing deps
- Maintainer-count or publish-pattern anomalies where derivable from metadata

**Explicit non-goal:** treating SLSA provenance as a pass signal. The June 2026 Red Hat/Miasma compromise shipped valid provenance from a compromised pipeline. Provenance presence is informational, never a green light.

### 2.4 `scan` — artifact & image scanning

```
npx lockwarden scan <path-to-artifact>
npx lockwarden scan --image <docker-image>
```

- Scans vendored/pre-baked `node_modules` inside tarballs, zips, and Docker image layers — catching the "tampered dep pre-baked in node_modules" vector that registry-level scanning never sees.
- Applies the same Layer-1 execution-surface analysis + Layer-2 known-bad matching to what is *actually on disk*, not what the manifest claims.
- Docker support v1: extract layers via `docker save` tarball parsing (no daemon API dependency).

### 2.5 `secrets` — hardcoded secret scan (secondary convenience)

```
npx lockwarden secrets [--dir <path>]
```

Regex + entropy scan for common credential patterns in the project and in dependency install-path files. Deliberately minimal — table-stakes convenience, never marketed as the differentiator.

### 2.6 Global flags

```
--json          machine-readable output
--sarif         SARIF 2.1.0 output (GitHub Security tab)
--ci            no colour/spinner, exit codes only
--dir <path>    monorepo package root(s), repeatable
--threshold <grade>   minimum severity that triggers exit 1 (default: high)
--offline       hard-fail any network call (guarantee for airgapped/paranoid CI)
```

## 3. Scoring model

### Layer 1 — Execution Surface Score (structural, day-zero capable)

| Signal | Absolute weight | Delta weight (newly appeared this version) |
|---|---|---|
| Lifecycle install script | Low–Med | **Critical** |
| `binding.gyp` / node-gyp hook | Low | **Critical** |
| AI-agent hook / MCP manifest | Med | **Critical** |
| IDE task / folder-open file | Med | **High** |
| Main-file size anomaly (>5x) | — | **High** |
| New transitive dep in a patch release | — | **High** |
| Obfuscation markers in install-path files | Med | **High** |
| Phantom dependency | Med | — |

- Per-package grade A–F; project rollup = worst grade + count summary.
- Delta weights apply only in `--diff` / `--deep` modes; absolute weights always apply.

### Layer 2 — Known-bad overlay (feed-based)

- Sources: OSV.dev export, npm advisory data, vendored incident IOC bundles.
- Match on resolved `name@version` from the lockfile.
- Any Layer-2 hit = **Critical**, regardless of Layer-1 score.

### SARIF mapping

| Grade | SARIF level |
|---|---|
| Critical | `error` |
| High | `warning` |
| Med | `note` |
| Low | suppressed by default (`--verbose` to include) |

## 4. Signal & data sources (v1)

| Source | Used for | Shipping model |
|---|---|---|
| Lockfiles (npm/yarn/pnpm) | Resolution truth | Read locally |
| Package tarballs (registry) | Delta comparison, content analysis | Fetched on demand, cached in `~/.lockwarden/cache` |
| OSV.dev dataset (npm subset) | Layer-2 matching | Vendored snapshot, refreshed each release |
| Incident IOC bundles | `check --incident` | Vendored, patch-released within hours of incidents |
| Git history | `check --history`, `drift --base` | Read locally |

No runtime API. The npm package release cadence *is* the data pipeline.

## 5. GitHub Action wrapper

```yaml
- uses: itsraghul/lockwarden/packages/action@v1
  with:
    command: audit          # audit | check | drift | scan
    diff-base: ${{ github.event.pull_request.base.sha }}
    threshold: high
    sarif: true             # uploads to Security tab automatically
```

- Thin wrapper: pins the CLI version, runs `--ci --sarif`, uploads SARIF via `github/codeql-action/upload-sarif`.
- Default PR behaviour: `audit --diff` (delta-scored, fast) + `drift --base`.
- Marketed default: add two lines, get execution-surface review on every dependency bump.

## 6. Non-goals (v1)

- No hosted dashboard, portal, accounts, or telemetry — ever, per trust model.
- No PyPI/other ecosystems (post-v1 candidate; npm depth beats breadth).
- No registry proxy / install blocking (that's Secure Registry's game; lockwarden is detection + review, not enforcement infrastructure).
- No provenance *verification* as a trust signal (informational only).
- No runtime/EDR-style behavioural monitoring.

## 7. v1 cut summary

| Feature | Status |
|---|---|
| `audit` (absolute + `--diff` delta) | v1 core — the wedge |
| `check` + `--incident` + `--history` | v1 core — distribution engine |
| `drift` | v1 |
| `scan` (tarball + docker-save) | v1, minimal |
| `secrets` | v1, minimal |
| `--deep` full-tree delta | v1 flag, marked slow |
| Precomputed delta index | post-v1 |
| PyPI support | post-v1 |

## 8. Competitive positioning

**One-sentence differentiation:** everyone else answers "is this package known-bad?" — lockwarden answers "what can this dependency tree execute, and what changed?"

| | lockwarden | Socket | Snyk | StepSecurity | npm audit |
|---|---|---|---|---|---|
| **Architecture** | Local CLI, zero backend | Hosted platform + GitHub app | Hosted platform | Hosted platform + registry proxy | Local, feed-based |
| **Account needed** | No | Yes (free tier) | Yes | Yes, enterprise sales | No |
| **Data leaves machine** | Never | Dep graph to their servers | Dep graph to their servers | Telemetry to their backend | No |
| **Primary detection** | Structural: execution surface + version deltas | Behavioral analysis (server-side) | Vulnerability DB (CVEs) | Known-bad DB + proxy blocking | Advisory DB only |
| **Day-zero (unreported) attacks** | Yes — delta anomalies need no feed | Partial | No | No (their own pitch admits DB lag) | No |
| **binding.gyp / AI-agent hooks / IDE tasks** | Yes (the wedge) | Partial | No | Device-level only (Dev Machine Guard) | No |
| **Vendored node_modules / Docker layers** | Yes | No (registry-level) | CVE-focused container scan only | No | No |
| **Historical exposure ("was I ever hit?")** | Free, from local git | — | — | Enterprise feature | No |
| **Pricing** | Free, OSS | Free tier → paid | Free tier → paid | Per-developer, sales-led | Free |

**Three-part moat:**
1. Structural/delta detection that works day zero, before any advisory exists.
2. Coverage of 2026-era vectors (native build hooks, AI-agent hooks, IDE task files, pre-baked node_modules) that incumbents haven't prioritized.
3. Trust model with no telemetry endpoint — malware now actively terminates and blocks StepSecurity agents in CI; a local tool has no endpoint to attack.

**Positioning discipline (do not violate):**
- Never pitch "better analysis than Socket." Socket's server-side behavioral analysis is deeper than any local heuristic can be. lockwarden wins on trust model, newer vectors, artifact scanning, and zero-friction triage — not analysis depth.
- Never drift into enforcement/blocking (Secure Registry's territory) or device posture scanning (Dev Machine Guard's territory). lockwarden is a project-scoped auditor.
- Description must be project-scoped: "audit what your dependency tree can execute" — never "free open-source supply-chain scanner" (no longer unique).

## 9. Workflow & CI/CD integration

Adoption funnel: **zero-commitment triage one-liner → two-line GitHub Action → habit.** Each step is one command away from the previous; no account, no dashboard, no sales call.

### 9.1 Incident day — zero integration (front door)
```bash
npx lockwarden check node-ipc@9.1.6
npx lockwarden check --incident shai-hulud-jun26
```
Works in any repo with a lockfile. Human-readable path trace showing how the package enters the tree; exit `1` if hit. Distribution moment: pasted into Slack/HN/Reddit threads during incidents.

### 9.2 PR gate — GitHub Action (retention hook)
```yaml
# .github/workflows/lockwarden.yml
- uses: itsraghul/lockwarden/packages/action@v1
  with:
    command: audit
    diff-base: ${{ github.event.pull_request.base.sha }}
    threshold: high
    sarif: true
```
Runs only on PRs touching the lockfile. `--diff` scores only changed packages → seconds, low-noise. Findings surface as failed checks + GitHub Security tab (SARIF). No new UI to learn.

### 9.3 Local pre-merge habit
```bash
npx lockwarden audit --diff main   # before merging Renovate/Dependabot PRs
npx lockwarden drift --base main   # lockfile tampering check
```
The Dependabot/Renovate review moment is the sharpest daily slot — compromised versions arrive exactly there, and reviewers currently rubber-stamp. **Deliberately not shipping a husky/pre-commit hook integration:** install-time hooks in a security tool invite irony; slow hooks get uninstalled.

### 9.4 Build pipeline — artifact verification (pre-deploy)
```bash
npx lockwarden scan --image myapp:latest   # scans node_modules actually in the image
npx lockwarden audit --offline              # airgapped CI; hard-fails any network call
```
The stage nobody else covers: verifying the shipped artifact, catching pre-baked tampered node_modules that never appeared in any manifest.

### 9.5 Distribution-thesis metric
Incident-day virality → Action installs is plausible but unproven. Track: **Action installs within 14 days of an incident spike.** If `npx` runs spike but installs don't follow, the funnel is broken and the retention hook needs rework.

## 10. Open items

1. Grade thresholds need tuning against a corpus: run Layer-1 against the top ~500 npm packages + the 2026 malicious set (Axios/plain-crypto-js, node-ipc 9.1.6/9.2.3/12.0.1, autotel family, @redhat-cloud-services Miasma versions) and verify separation.
2. Obfuscation-marker heuristics: define the v1 rule list (eval-chain depth, hex-array density, string-packing patterns) — keep small, tune for precision over recall; Layer-1 delta signals carry recall.
3. ~~Name check~~ **DONE (03 Jul 2026):** `lockwarden` is claimed — npm placeholder published (`lockwarden@0.0.1`) and GitHub repo `itsraghul/lockwarden` created. Remaining namespace tasks: publish `lock-warden` alias on npm, reserve `lockwarden` on PyPI, and republish placeholder as 0.0.2 without the stray `files.zip` that shipped in 0.0.1 (then `npm unpublish lockwarden@0.0.1` within the 72h window). Original name `depsentry` was rejected — taken on npm.
