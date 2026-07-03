# Lockwarden — Use Case & Learnings

A companion to `lockwarden-v1-spec.md`. The spec says *what to build*; this doc explains *why it's shaped this way* — the threat landscape, the use cases, the competitive logic, and the decisions with their reasoning. Read this first when returning to the project after a gap.

---

## 1. The problem in plain terms

Modern npm attacks don't wait for you to run the malicious code — they run **when you install or build**, before a single line of your app executes. The attacker's job is to get code execution on a developer machine or CI runner; the package contents are just the delivery vehicle.

The execution vectors, in order of how the ecosystem's attacks evolved through 2025–26:

1. **Lifecycle scripts** (`preinstall`/`postinstall`) — the classic vector; now widely watched.
2. **AI-agent hooks** — config files inside packages that AI coding agents (Claude, Cursor, Copilot) execute on session start; malware also harvests AI-tool credentials and MCP configs.
3. **IDE task files** — `.vscode/tasks.json` and folder-open tasks that fire when a developer merely opens the project.
4. **Native build hooks** — `binding.gyp` / node-gyp, which executes at install time even with lifecycle scripts disabled. Used by the May 2026 node-ipc compromise and the June 2026 node-gyp worm (57 packages).
5. **Pre-baked tampering** — malicious code shipped already vendored inside a package's `node_modules`, invisible to any registry- or manifest-level scanner.

Traditional tooling (npm audit, Snyk) answers "does this package have a *reported* vulnerability?" That model fails twice: it misses malicious-by-design packages until someone reports them, and it never looks at execution surface at all.

## 2. What 2026 proved

Each major incident this year validates a specific lockwarden feature:

| Incident | What happened | Feature it validates |
|---|---|---|
| **Axios (Mar 2026)** | Phantom transitive dep `plain-crypto-js` ran a postinstall payload, then replaced its own files with clean decoys. Only visible in the lockfile, not package.json. One variant shipped the tampered code pre-baked in vendored node_modules. | Lockfile-first resolution; phantom-dep detection; `scan` for vendored node_modules |
| **node-ipc (May 2026)** | Malicious payload via binding.gyp node-gyp hook at install time; credentials harvested from CI. Published across multiple major version lines simultaneously to maximize semver-range blast radius. | binding.gyp detection; `check` resolving all transitive lockfile matches |
| **Shai-Hulud / Miasma waves (2025–26)** | Worm family evolving from lifecycle scripts → AI-agent SessionStart hooks + IDE folder-open tasks → node-gyp. Moved faster than known-bad databases could update. | The full execution-surface wedge; structural detection over feeds |
| **Red Hat namespace / Miasma (Jun 2026)** | Attacker triggered the victim's own GitHub Actions to publish Trojanized packages **with valid SLSA provenance**. A ~200 KB index.js became a 4.29 MB obfuscated payload — a 25x size jump. | Provenance ≠ trust (non-goal); size-delta anomaly as a detection signal |
| **CI-targeting malware (2026)** | Malware identifies StepSecurity Harden-Runner containers, kills them, and poisons /etc/hosts to block their telemetry domains. Also loots AI-tool credentials and password-manager vaults. | The local-first trust model — no telemetry endpoint exists to attack |

**Scale context:** 454,600+ new malicious packages in 2025, up 75% year-over-year. Demand-side doubt is dead; the open question is competitive crowding, not whether the problem is real.

## 3. The five use cases

### UC1 — Pre-merge audit: "what can execute if I add this?"
Daily-driver flow. A Dependabot/Renovate PR bumps a dependency; `audit --diff` scores only the changed packages and reports every *new* execution surface introduced. This is where compromised versions actually arrive, and where reviewers currently rubber-stamp.

### UC2 — Incident triage: "am I hit?"
Every major incident produces the same hours-long scramble across thousands of teams. `npx lockwarden check <pkg>@<ver>` answers from the **resolved lockfile** — including transitive paths — not from package.json. Semver ranges make the difference material: teams pinned to `^9` got node-ipc's payload automatically on their next install. This one-liner is also the distribution engine: posted into incident threads, it's the tool's viral moment. Incident-day responsiveness (IOC bundles shipped within hours) is a strategy, not a feature.

### UC3 — Drift detection: "did my lockfile change in ways my manifest doesn't explain?"
Lockfile-only version changes, integrity-hash swaps, tarball URL moves, new packages entering via patch bumps. Key learning baked in: **valid provenance is not a green light** — the Miasma compromise had legitimate SLSA certificates from a compromised pipeline. Version-to-version *anomaly* (new install hook, size jump, new transitive dep) is the honest signal.

### UC4 — CI hardening: making generic advice actionable
Standard advice says "set ignore-scripts=true" — but that breaks native modules, so teams don't do it. lockwarden tells you *which* deps actually need install scripts, converting a blanket recommendation into a minimal allowlist. A wedge no incumbent owns.

### UC5 — Artifact/image verification: "what's actually in the thing I ship?"
Registry-level scanning never sees vendored node_modules inside a tarball or Docker layer. `scan` applies the same analysis to what's on disk. Directly validated by the Axios variant that shipped tampering pre-baked.

## 4. Competitive logic (the short version)

Full table lives in the spec (§8). The reasoning:

- **Socket** is the strongest incumbent. Their server-side behavioral analysis is deeper than any local heuristic can be. lockwarden never competes on analysis depth — it competes on trust model (nothing leaves your machine), 2026-era vector coverage, artifact scanning, and zero-friction triage.
- **StepSecurity** claimed the "install-time defense" narrative in May 2026 with Secure Registry — but their model is a hosted proxy plus per-developer enterprise pricing. Their own marketing concedes PR-stage known-bad databases lag attacks; lockwarden's structural detection is the day-zero answer they can't make locally. Their open-source Dev Machine Guard scans *device posture*, not *project dependency trees* — different question.
- **The trust argument is now technical, not just philosophical:** 2026 malware actively terminates StepSecurity agents and blocks their telemetry domains. A tool with no backend has no endpoint to attack or block.
- **npm audit / Snyk** are feed-driven and structurally blind to execution surface. Table stakes, not threats.

**One-sentence differentiation:** everyone else asks "is this package known-bad?" — lockwarden asks "what can this tree execute, and what changed?"

## 5. Key design decisions and why

| Decision | Reasoning |
|---|---|
| **Delta scoring over absolute scoring** | Legitimate native packages carry binding.gyp forever; attacks *introduce* it in one version. Scoring what changed is low-noise and matches how every 2026 attack actually looked (new hook, 25x size jump, new transitive dep in a patch). |
| **PR-scoped deltas in v1, full-tree behind `--deep`** | Delta comparison requires fetching the previous version's tarball. Scoping to lockfile-diff keeps the PR flow fast (seconds) and makes CI the hero use case. Precomputed index deferred until demand proves it. |
| **Lockfile as source of truth, never package.json** | Axios's malicious dep was transitive and lockfile-only. Semver ranges mean the manifest doesn't tell you what you actually resolved. |
| **Structural detection primary, feeds secondary** | Feeds only catch reported packages; worms outran the databases. Execution-surface + delta analysis works on day zero with zero network. |
| **No telemetry, no accounts, no backend — ever** | The core differentiator and now a demonstrated security property. Data pipeline = npm release cadence (vendored advisory snapshots, incident IOC bundles patch-released within hours). |
| **Detection, not enforcement** | Blocking installs means running registry-proxy infrastructure — StepSecurity's game, and a betrayal of zero-infrastructure positioning. |
| **Provenance is informational, never a pass** | Miasma shipped valid SLSA provenance from a hijacked pipeline. |
| **`--offline` hard-fail flag** | One cheap flag that lets paranoid/airgapped teams *prove* the local-first claim. |
| **No pre-commit hook integration** | A security tool installing install-time hooks invites irony; slow hooks get uninstalled. |
| **`--history` from local git** | Incumbents charge enterprise money for historical-exposure windows; one repo's answer is derivable from `git log -p` on the lockfile for free. README wow-moment. |

## 6. Adoption funnel & distribution thesis

**Zero-commitment one-liner → two-line GitHub Action → habit.**

1. Incident day: `npx lockwarden check --incident <id>` pasted in threads. No install, no account.
2. The scared-straight moment converts to the Action: two lines of YAML, findings in the Security tab teams already use.
3. Retention comes from the PR gate being fast and low-noise (delta scoring is what makes this possible).

**Unproven assumption, named:** incident virality converts to Action installs. Metric to watch: Action installs within 14 days of an incident spike. If `npx` runs spike without installs, the funnel is broken.

**Second unproven assumption:** patch-releasing IOC bundles within hours of incidents is sustainable for a solo maintainer. If two major incidents land in one week while you're busy, the "incident-day speed" promise breaks publicly. Mitigation options: automate bundle generation from public IOC feeds; or scope the promise ("bundles for top-100-download incidents").

## 7. Standing principles (carried from the evaluation process)

- **Single sharp wedge, not a platform.** The wedge is execution-surface auditing. Everything else (secrets, drift) is supporting cast and stays minimal.
- **Distribution answered upfront:** `npx` zero-install triage is baked into the architecture (no account, no config, lockfile-only), not retrofitted.
- **Local-first is non-negotiable** — a hosted dashboard was already evaluated and rejected; uploading dependency graphs undermines the differentiator.
- **"I want this myself" is a yellow flag.** The second-user test for lockwarden = a stranger running the one-liner during an incident and then installing the Action. That's the validation bar.
- **Noisy v1 kills trust.** Grade-threshold calibration against a real corpus (top ~500 packages + 2026 confirmed-malicious set) is the required gate before writing CLI code. A tool that flags every native package goes straight to the uninstall pile in the exact community it needs.

## 8. Naming decision record (Jul 2026)

**Final name: `lockwarden`** — GitHub `itsraghul/lockwarden`, npm `lockwarden`, CLI `npx lockwarden`.

| Candidate | Outcome | Reason |
|---|---|---|
| `depsentry` (original) | Rejected | Taken on npm — existing security-adjacent package (dependency checksum verifier, active maintainer). Kills the `npx` one-liner. |
| `dep-guardian` | Rejected | Available itself, but `depguardian` (unhyphenated) is owned by a third party — the most natural mistyping of the name would execute someone else's code. Unacceptable typo-hazard for a security tool. |
| `dep-shield` | Rejected hard | Sonatype DepShield was a well-known free GitHub dependency-scanning app (2018–2022, deprecated) from a company now ranked a Gartner Leader in supply-chain security. Trademark exposure + permanently polluted SEO + `depshield` taken on npm. |
| `lockwarden` | **Chosen** | Clean across npm (including all typo variants `lock-warden`/`lockwardn`/`lockwardens`), PyPI, and web. "Lock" points at the lockfile — the actual source of truth — and "warden" says watching without implying enforcement (a stated non-goal). Only known residue: a 6-star hobbyist password manager on GitHub and a Warhammer 40k character; neither is a commercial or trademark conflict. Noted low-risk adjacency to Bitwarden's "-warden" space (Bitwarden tolerates Vaultwarden; different category). |

**Standing rule reaffirmed:** for any future tool, verify the name AND its unhyphenated/typo variants on npm before attachment forms — and register the variants you can.

## 9. Immediate next actions (in order)

1. ~~Claim the namespace~~ **MOSTLY DONE (03 Jul 2026):** npm `lockwarden@0.0.1` published; GitHub `itsraghul/lockwarden` created. Remaining: `lock-warden` alias on npm, PyPI reservation, and clean republish as 0.0.2 (0.0.1 accidentally included a stray `files.zip` — unpublish it within 72h). Lesson recorded: always run `npm publish --dry-run` first and read the tarball contents list — especially for a security tool, whose own package hygiene is marketing.
2. **Corpus calibration** — build the benign + malicious package corpus, run the Layer-1 signals, tune weights for separation. Blocker for all CLI code.
3. **Define lockwarden kill criteria** — the Firebase track has a scoped timebox; this track still doesn't. Candidate frame: N weeks post-launch, X Action installs or Y GitHub stars from non-personal-network sources, else park.
4. Only then: CLI implementation, starting with `check` (smallest surface, biggest distribution payoff).
