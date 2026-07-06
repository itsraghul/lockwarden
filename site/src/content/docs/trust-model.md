---
title: Trust model
description: Local-first architecture, the single network chokepoint, the --offline guarantee, the vendored-data pipeline, the 3-dependency budget, and the provenance stance.
---

A supply-chain security tool asks you to trust it with the most sensitive metadata you
have: your full dependency graph. lockwarden's answer is architectural, not contractual —
**there is no backend to send it to.**

## Local-first, by construction

- **No accounts.** There is nothing to sign up for.
- **No telemetry.** No analytics, no crash reporting, no phone-home — ever.
- **No API backend.** Advisory data (the OSV snapshot and
  [incident bundles](/incidents/)) ships vendored inside the npm package and updates via
  npm releases. The release cadence is the data pipeline.

This stopped being a purely philosophical stance in 2026: CI-targeting malware now
identifies hosted security agents, kills their containers, and poisons `/etc/hosts` to
block their telemetry domains. A tool with no endpoint has no endpoint to attack, block,
or subpoena. (Full reasoning:
[architecture decisions → local-first](/project/architecture-decisions/#4-local-first-zero-telemetry-zero-accounts).)

## The only network calls

Exactly one feature needs the network: **delta comparison**. To score what a version
bump *introduced*, lockwarden must fetch the previous version's tarball from the
registry.

| Operation | When | What is fetched |
| --- | --- | --- |
| [`audit --diff <ref>`](/commands/audit/) | PR flow | Previous tarball of each package whose resolved version changed |
| [`audit --deep`](/commands/audit/) | Scheduled deep scans | Previous tarball of every dependency |

That's the complete list. [`check`](/commands/check/), [`drift`](/commands/drift/),
[`scan`](/commands/scan/), [`secrets`](/commands/secrets/), and plain `audit` perform
zero network I/O.

### The single chokepoint

This isn't a policy — it's structural. Every byte lockwarden ever fetches flows through
one module,
[`src/lib/net.ts`](https://github.com/itsraghul/lockwarden/blob/main/packages/cli/src/lib/net.ts),
the **only file in the codebase permitted to reference `fetch`** — a unit test enforces
that structurally, so a contributor (or a compromised dependency of ours) can't quietly
add a second network path without failing CI. The module's own header states the
contract:

```ts
/**
 * THE ONLY network module. Every byte lockwarden ever fetches flows through
 * request() — no other file may reference fetch (enforced by
 * test/unit/net-chokepoint.test.ts). Network use is allowed ONLY for
 * registry tarball fetches during --diff/--deep delta comparison.
 */
```

Fetched tarballs are **SRI-verified** against the lockfile's integrity hash before being
cached or analyzed — a tarball that fails its own lockfile integrity is exactly the
tampering lockwarden exists to catch, so the run refuses it (exit `2`). Verified
tarballs are cached in `~/.lockwarden/cache` (override: `LOCKWARDEN_CACHE_DIR`), keyed
by URL hash, so each previous version is fetched at most once across runs.
`LOCKWARDEN_REGISTRY` exists for self-hosted registries; lockwarden itself never phones
home anywhere.

## The `--offline` guarantee

`--offline` is how you *prove* the claim rather than take it on faith:

```bash
npx lockwarden audit --offline   # exits 2 if any network call is even attempted
```

Enforcement lives in the chokepoint: with `--offline` set, `net.ts` throws **before any
dispatch** — the process exits `2` the moment a fetch is attempted, with the offending
URL named:

```
lockwarden: --offline is set but a network call to https://registry.npmjs.org/nested-lib/-/nested-lib-3.0.2.tgz was attempted
  hint: Remove --offline, or avoid flags that require tarball fetches (--diff/--deep).
```

The behaviour is locked in by tests that fail the suite on any network attempt — offline
is a tested invariant, not a best effort. A warm tarball cache also counts as offline:
cache hits never touch the network, so only an *actually required* fetch trips the
guarantee. That's what makes
[delta scoring on airgapped runners](/guides/ci-recipes/#--offline-for-airgapped-runners)
practical: warm the cache on a connected machine, mount it, run `--diff --offline`.

## The vendored-data pipeline

There is no feed to poll, so advisory data travels the only channel that exists: **npm
releases**.

1. The OSV npm-malware snapshot and incident IOC bundles live as JSON inside the
   package (`src/data/`), inlined into the single-file build.
2. When an incident lands, a bundle is validated, self-tested (a lockfile containing a
   listed package must exit `1`; a clean one must exit `0`), and published as an npm
   patch release — an automated workflow takes a bundle JSON to a published release,
   targeting hours, not days.
3. **The OSV snapshot refreshes weekly, automatically.** A scheduled workflow pulls the
   OSV.dev npm malicious-package dataset, keeps the largest recency window that fits a
   fixed size budget (plus a keep-list guaranteeing canonical incident entries never
   vanish), runs the same validate/self-test gate, and publishes a patch release —
   no human in the loop. A quiet week publishes nothing.
4. Updating is running the latest version — which `npx lockwarden` does by default.
   The report's `advisories` dates show what your install carries, and
   [`--max-advisory-age`](/getting-started/#global-flags) turns staleness into a CI
   failure — the dead-man's-switch that surfaces a silently dead refresh pipeline.

You get auditable, versioned, reproducible advisory data — a bundle is a diffable JSON
file in a release published with npm provenance — instead of an opaque live endpoint
that malware can block. Details and schema: [incident bundles](/incidents/).

## Provenance is informational — never a pass signal

lockwarden reports SLSA provenance where present, but **never treats it as a green
light**. The June 2026 Miasma compromise published trojanized packages with *valid*
provenance, generated by the victim's own hijacked GitHub Actions pipeline. Provenance
tells you which pipeline built the package — not whether that pipeline was compromised.
Version-to-version structural anomaly (new install hook, 25× size jump, new transitive
dep in a patch) is the honest signal, and it's what the [scoring model](/scoring/)
weights. [`drift`](/commands/drift/) prints this reminder on every run.

## Detection, not enforcement

lockwarden never blocks installs and never proxies the registry. It detects, grades, and
reports; the [exit code](/reference/exit-codes/) feeds *your* policy (branch protection,
pipeline gates). Running enforcement infrastructure would mean running infrastructure —
and the whole point is that there isn't any.

## Our own dependency tree is part of the model

A tool that audits dependency trees should survive its own audit. The published CLI has
**3 runtime dependencies — each with zero transitive dependencies** — under a hard
project budget of fewer than 10 total:

| Dependency | Why it's worth a slot |
| --- | --- |
| `commander` | CLI argument parsing — the one piece of plumbing every command shares; mature, dependency-free |
| `semver` | Correct semver range matching is genuinely hard, and `check` queries and patch-bump detection ride on getting it exactly right |
| `yaml` | `pnpm-lock.yaml` is YAML; a hand-rolled YAML parser is a bigger risk than the dependency |

Everything else that would normally be a dependency is custom: tar reading, zip reading,
yarn.lock parsing, SRI verification, SARIF emission, docker-save layer walking. CI runs
`lockwarden audit` against the lockwarden repository itself on every build and fails on
any High+ finding. Every release is published with npm provenance and an explicit
`files` allowlist, and CI diffs the tarball contents against an expected-files list —
nothing unexplained ships. (Yes, we just said provenance isn't a pass signal — publish
it anyway, treat it as one more informational datum.)

## See also

- [Architecture decisions](/project/architecture-decisions/) — each of these choices in
  Context/Decision/Consequences form.
- [Comparison](/project/comparison/) — how this trust model differs from hosted
  platforms, and what hosted platforms do better.
- [CI recipes → `--offline`](/guides/ci-recipes/#--offline-for-airgapped-runners) — the
  airgapped patterns.
