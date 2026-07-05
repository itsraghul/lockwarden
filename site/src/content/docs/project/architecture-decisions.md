---
title: Architecture decisions
description: The load-bearing design decisions behind lockwarden, ADR-style — context, decision, and consequences for each, from delta scoring to the dependency budget.
---

lockwarden's design is a small number of firm decisions applied consistently. This page
records each one ADR-style — context, decision, consequences — so contributors and
evaluators can see *why* the tool is shaped this way. Source documents:
[ARCHITECTURE.md](https://github.com/itsraghul/lockwarden/blob/main/docs/ARCHITECTURE.md)
and
[THREAT-MODEL.md](https://github.com/itsraghul/lockwarden/blob/main/docs/THREAT-MODEL.md)
in the repo.

## 1. Delta over absolute scoring

**Context.** Legitimate native packages carry `binding.gyp` forever; legitimate build
tools run `postinstall` forever. Flagging mere *existence* produces noise that sends a
security tool straight to the uninstall pile. Meanwhile, real 2026 attacks consistently
**introduced** execution surface in a single version: a new install script, a
newly-added build hook, a 25× main-file size jump, a new transitive dep under a patch
bump.

**Decision.** Weight *what changed between versions* far above what merely exists.
Every signal carries an absolute weight and a heavier delta weight; the
[Critical-tier weights](/scoring/#layer-1--execution-surface-signals) are all deltas.

**Consequences.** `audit --diff` is the flagship flow and needs the previous tarball
(the only network use in the tool). Absolute mode still fires, at low severities, so a
first scan isn't blind. False-positive pressure concentrates on delta signals — which is
what the [corpus gate](#9-corpus-gated-weights--analyzers-are-born-in-corpus) controls.

## 2. The lockfile is the source of truth

**Context.** Semver ranges mean `package.json` doesn't tell you what you actually
resolved. The 2026 attacks lived in transitive, lockfile-only resolutions — the axios
incident's `plain-crypto-js` never appeared in any manifest; node-ipc rode `^9` ranges
into trees whose manifests never changed.

**Decision.** All resolution comes from `package-lock.json` (v1/v2/v3), `yarn.lock`
(classic + berry), or `pnpm-lock.yaml` (6.x/9.x) — never from `package.json` alone.
Every parser normalizes into one unified resolution graph (`name@version` nodes plus
explicit edges, with a reverse index), so everything downstream is lockfile-agnostic.

**Consequences.** Three parsers to maintain with heavy test coverage — the price of
answering the question correctly. [`check`](/commands/check/) can report *every
transitive path* via a cycle-safe reverse walk, and `check --history` can replay the
lockfile through git history. Projects without a lockfile can't be audited (by design).

## 3. Structural detection primary, feeds vendored and secondary

**Context.** Advisory databases lag attacks by design; the 2026 worm waves moved faster
than any known-bad list could update. But when an incident *is* known, confirming it
should be instant and unambiguous.

**Decision.** Layer 1 (execution surface + version anomalies) must work with zero
network and zero advisory data. Layer 2 (the OSV snapshot + incident bundles) is an
overlay: any hit is Critical, but nothing depends on it. Advisory data ships **vendored
in the npm package** — the release cadence *is* the data pipeline, with an automated
path from validated bundle JSON to a published patch release within hours.

**Consequences.** Day-zero capability without a feed. Advisory freshness is bounded by
release cadence — mitigated by `npx` defaulting to latest and by
[`LOCKWARDEN_INCIDENT_DIR`](/incidents/#staging-your-own-bundles-lockwarden_incident_dir)
for staging. Advisory data is auditable and reproducible (diffable JSON in signed
releases) instead of an opaque endpoint.

## 4. Local-first, zero telemetry, zero accounts

**Context.** A supply-chain tool holds the most sensitive metadata a team has: the full
dependency graph. And in 2026 the hosted model acquired a demonstrated failure mode:
malware that identifies hosted-agent security containers, terminates them, and poisons
`/etc/hosts` to block their telemetry domains.

**Decision.** No analytics, no phone-home, no API backend — ever. Nothing leaves the
machine. Network use exists for exactly one purpose (previous-tarball fetches during
delta comparison) through [one chokepoint](#11-the-offline-chokepoint-design).

**Consequences.** There is no endpoint to attack, block, or subpoena — the trust model
is architectural, not contractual. The costs are real and accepted: no org dashboards,
no server-side analysis depth, no usage data to guide development. See the
[comparison](/project/comparison/) for what hosted platforms do better.

## 5. Detection, not enforcement

**Context.** Blocking installs or proxying the registry would put lockwarden in the
critical path of every install — which means running infrastructure, which contradicts
the zero-backend model; a broken blocker also trains users to bypass it.

**Decision.** lockwarden detects, grades, and reports. The
[exit code](/reference/exit-codes/) feeds *your* policy (branch protection, pipeline
gates); lockwarden never blocks anything itself.

**Consequences.** CI-composability is the product surface — which is why exit codes and
[stable JSON](/reference/json-output/) are treated as API contracts, snapshot-tested.

## 6. Provenance is informational, never a pass signal

**Context.** The June 2026 Miasma compromise published trojanized packages **with valid
SLSA provenance** — generated by the victim's own hijacked CI pipeline. Provenance
proves which pipeline built a package, not that the pipeline was trustworthy at the
time.

**Decision.** Provenance is reported as context, never as a green light. No lockwarden
verdict improves because provenance is present.

**Consequences.** [`drift`](/commands/drift/) prints the reminder on every run.
Structural version-to-version anomaly remains the honest signal. lockwarden's *own*
releases still publish provenance — as one more informational datum for its users, held
to the same standard.

## 7. The dependency budget: fewer than 10, currently 3

**Context.** A supply-chain security tool's own dependency tree is a marketing artifact
— and an attack surface. Every transitive dep is a party you trust with your users'
machines.

**Decision.** A hard budget of fewer than 10 total transitive runtime dependencies. The
CLI ships **3**, each with zero transitive deps: `commander` (CLI parsing), `semver`
(range matching correctness), `yaml` (`pnpm-lock.yaml`). Everything else is custom:
tar and zip reading, yarn.lock parsing, SRI verification, SARIF emission, docker-save
layer walking.

**Consequences.** More first-party code to maintain and test — accepted. CI runs
`lockwarden audit` on the lockwarden repo itself every build and fails on High+
findings; the release pipeline diffs tarball contents against an explicit allowlist.
The [why-each-dep table](/trust-model/#our-own-dependency-tree-is-part-of-the-model) is
public.

## 8. Single-file bundle for `npx` cold start

**Context.** The incident-day promise is `npx lockwarden check …` with no prior
install. `npx` cold-start time is dominated by dependency count and file count.

**Decision.** `tsup` bundles the CLI into a single `dist/index.js` (Node 20 target,
ESM), with vendored advisory JSON inlined at build time.

**Consequences.** Fast cold start with only the 3 runtime deps to install; the whole
tool is one auditable file on disk. Bundling also makes the tarball-contents allowlist
gate trivial to review.

## 9. Corpus-gated weights — analyzers are born in `corpus/`

**Context.** Detection weights chosen by intuition are noise generators. A weight is
only meaningful relative to how real benign packages and real attack shapes actually
score.

**Decision.** Analyzers are written first in `corpus/` (a calibration harness that is
never shipped), run against top-download benign tarballs and synthetic defanged
malicious fixtures, and only then promoted verbatim into the CLI. The shipped weights
file is generated from the corpus separation report — never hand-edited — and the gate
requires every malicious fixture to grade F in delta mode while benign version bumps
produce zero Criticals. After promotion, the corpus re-imports the shipped module, so
calibration keeps validating exactly what ships.

**Consequences.** Weight changes are reproducible experiments, not review debates.
Weights stay [formally provisional](/scoring/#calibration-weights-are-gated-on-a-corpus)
until the benign set reaches the full top-500. Contributing an analyzer means
contributing corpus evidence — see
[CONTRIBUTING](https://github.com/itsraghul/lockwarden/blob/main/docs/CONTRIBUTING.md).

## 10. No pre-commit hook integrations

**Context.** Install-time hooks (husky and friends) execute code on developers'
machines as a side effect of `npm install` — which is precisely the attack vector
lockwarden exists to audit.

**Decision.** lockwarden ships no pre-commit/husky integrations and never installs
hooks of any kind. Integration points are explicit invocations: CLI calls, CI steps,
the [GitHub Action](/github-action/).

**Consequences.** Slightly more setup for teams that wanted a git-hook workflow — they
can wire one themselves, deliberately. The tool never adds itself to anyone's install
execution surface.

## 11. The offline chokepoint design

**Context.** "We don't phone home" is an easy claim and an unverifiable one — unless
the architecture makes it checkable.

**Decision.** All network I/O flows through a single module
([`src/lib/net.ts`](https://github.com/itsraghul/lockwarden/blob/main/packages/cli/src/lib/net.ts))
— the only file permitted to reference `fetch`, enforced by a structural unit test that
fails CI if any other file references it. `--offline` makes the chokepoint throw before
any dispatch (exit `2`, offending URL named).

**Consequences.** The local-first claim is [provable per run](/trust-model/#the---offline-guarantee),
not asserted: airgapped CI adds `--offline` everywhere and any regression fails loudly.
New network features are structurally impossible to add quietly — a PR would have to
touch the chokepoint or break the test.

## See also

- [Trust model](/trust-model/) — decisions 4, 6, 7, and 11 from the user's perspective.
- [Scoring](/scoring/) — decisions 1 and 9 in operation.
- [Comparison](/project/comparison/) — the trade-offs these decisions buy, stated
  fairly.
- [Contributing](/project/contributing/) — the ground rules these decisions imply.
