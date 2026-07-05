---
title: "lockwarden vs Socket, Snyk, StepSecurity, npm audit"
description: A fair, factual comparison — architecture, trust model, detection method, and coverage — including when the hosted platforms are the better choice.
---

These tools overlap less than their category suggests. Most ask *"is this package
known-bad (or known-vulnerable)?"* — lockwarden asks *"what can this tree execute, and
what changed?"* This page is a factual comparison, including the cases where the other
tools are the better choice. Many teams run lockwarden *alongside* a hosted platform;
nothing here is either/or.

## The table

| | lockwarden | Socket | Snyk | StepSecurity | npm audit |
| --- | --- | --- | --- | --- | --- |
| Architecture | Local CLI, no backend | Hosted platform + GitHub app/CLI | Hosted platform + CLI | Hosted platform + runner agent | Built into npm; queries the registry advisory API |
| Account required | No | Yes (for the platform features) | Yes | Yes | No |
| Where your dependency graph goes | Nowhere — analysis on your machine/runner | Analyzed by their service | Analyzed by their service | Runner telemetry to their service | Package list sent to the registry endpoint |
| Primary detection method | Structural: execution-surface enumeration + version-delta scoring from the lockfile | Behavioral/heuristic analysis of package code, server-side | Known-vulnerability database (SCA) + license/code tools | CI/runner hardening: egress filtering, action pinning, runtime monitoring | Known-advisory lookup |
| Day-zero / unreported packages | Yes — structural Layer 1 needs no advisory to fire | Partial — proactive analysis catches many pre-report; depth beyond lockwarden's local heuristics | No — needs a published advisory | Different layer — catches *effects* (e.g. unexpected egress) at runtime | No — needs a published advisory |
| 2026-vector coverage (`binding.gyp` deltas, AI-agent hooks/MCP manifests, IDE task files) | Yes — first-class signals | Partial (install scripts and code analysis; vector set differs) | Not a focus | Not package-content analysis | No |
| Vendored `node_modules` & docker-layer scanning | Yes — [`scan`](/commands/scan/) audits artifacts on disk | No (registry/manifest level) | Container scanning exists (vulnerability-focused) | No | No |
| Historical exposure ("were we ever resolving it?") | Yes — [`check --history`](/commands/check/#example-4--historical-exposure-with---history) from local git | No | No | No | No |
| Pricing model | Free, MIT | Free tier + paid plans | Free tier + paid plans | Free tier + paid plans | Free |

Row-level honesty notes: Socket's and Snyk's capabilities evolve quickly — verify
current feature sets against their own docs; this table reflects their architecture
class (hosted analysis) rather than a point-in-time feature audit.

## When Socket or Snyk is the better choice

Be clear-eyed about what a hosted platform buys you:

- **Deeper analysis than local heuristics.** Socket's server-side behavioral analysis
  of package code *is* deeper than what lockwarden's local structural heuristics can do
  — they analyze what code does (network, filesystem, env access), across the whole
  registry, continuously, with ML and human review behind it. lockwarden's Layer 1 is
  deliberately shallow-and-structural so it can run anywhere in seconds with zero
  network; that's a trade, not a free lunch.
- **Org-wide visibility.** Dashboards across hundreds of repos, policy management,
  ownership routing, trend reporting. lockwarden has no dashboard — its
  [outputs](/reference/json-output/) are exit codes, JSON, and SARIF, and aggregation
  is your job.
- **Richer triage workflows.** Assignments, ignores with expiry, PR comments with
  remediation advice, license compliance, CVE management with fix PRs (Snyk's core
  strength). lockwarden intentionally does none of this.
- **CI hardening as a layer.** StepSecurity addresses a different problem — hardening
  the runner itself (egress filtering, action pinning, runtime detection). lockwarden
  audits *package trees*, not runners. These are complementary, not competing.

If you want those things, use those tools — running lockwarden as well costs one CLI
invocation and gives you the local-first properties below.

## When lockwarden fits

- **The trust model is the requirement.** Your dependency graph can't leave the
  machine — regulated environments, airgapped CI, or plain policy. lockwarden has no
  backend by construction, and [`--offline`](/trust-model/#the---offline-guarantee)
  makes the claim verifiable per run, not contractual.
- **Incident triage speed.** `npx lockwarden check <pkg>@<ver>` answers "am I hit,
  through which paths?" from the resolved lockfile in seconds — no account, no
  onboarding, works in any repo you can `cd` into. And
  [`--history`](/guides/incident-response/#step-3--were-we-ever-exposed----history)
  answers "were we *ever*?", which no registry-time scanner can.
- **Artifact scanning.** The tampering that never appears in any manifest — pre-baked
  `node_modules` in a tarball or docker layer — is invisible to registry-level
  analysis by definition. [`scan`](/commands/scan/) audits the bytes you actually ship.
- **PR delta gating.** [`audit --diff`](/commands/audit/) scores what a bump
  *introduced* — a new install script, a new build hook, a new dep under a patch —
  which is a low-noise, high-signal gate that runs on your runner in seconds.
- **Zero accounts, zero friction.** The whole integration is
  [one line of shell](/quickstart-ci/) or a
  [two-line Action](/github-action/); nothing to procure, nobody to onboard.

## npm audit, specifically

`npm audit` is free, built-in, and worth running — but it answers only "does a resolved
package have a *published advisory*?" It misses malicious-by-design packages until
someone reports them, and it never looks at execution surface. The 2026 worm waves
outran advisory databases as a strategy. Use `npm audit` for CVE hygiene; use lockwarden
for the question advisories can't answer yet. (This is also lockwarden's Layer 2
[known-bad overlay](/scoring/#layer-2--known-bad-overlay) — vendored, offline — which is
deliberately the *secondary* layer.)

## What lockwarden is not

For complete clarity about scope — lockwarden is deliberately **not**:

- a device/endpoint scanner (it audits a project's tree, not your machine);
- a registry proxy or install blocker ([detection, not enforcement](/trust-model/#detection-not-enforcement));
- a hosted platform (no accounts, no dashboard, no backend — ever);
- a runtime/EDR behavioral monitor;
- a provenance verifier used as a trust gate ([provenance is informational](/trust-model/#provenance-is-informational--never-a-pass-signal)).

## See also

- [Trust model](/trust-model/) — the architecture behind the trust-model rows.
- [Architecture decisions](/project/architecture-decisions/) — why these trade-offs
  were chosen deliberately.
- [Getting started](/getting-started/) — try the one-liner and judge for yourself.
