---
title: Dependency review
description: The daily habit — review Renovate/Dependabot PRs with audit --diff, interpret delta findings, maintain an ignore-scripts allowlist, and run drift before merging.
---

Most supply-chain compromises arrive the boring way: a routine version bump, merged
because it was routine. This guide is the workflow that makes bumps reviewable in
seconds — locally or as a [CI gate](/guides/ci-recipes/).

## Reviewing a Renovate/Dependabot PR

Check out the PR branch and delta-score exactly what it changes:

```bash
npx lockwarden audit --diff main
```

`--diff` compares the working lockfile against the base ref, then analyzes **only the
packages whose resolved version changed** — fetching each one's *previous* tarball
(SRI-verified, cached in `~/.lockwarden/cache`) to compute what the new version
*introduced*. A clean bump:

```
grade A — 0 packages flagged of 4 analyzed
no findings
lockfile: package-lock.json (npm) — mode: diff
```

Exit `0`, merge on. And a bump that deserves a very close look:

```
grade F — 2 packages flagged of 2 analyzed
critical 2 · med 2
lockfile: package-lock.json (npm) — mode: diff

  dep-a@1.0.1 — grade F
    [critical] LW001D-LIFECYCLE-INTRODUCED package.json — lifecycle script "postinstall" is NEW in 1.0.1 (absent in 1.0.0)
    [med] LW001-LIFECYCLE package.json — lifecycle script "postinstall" runs automatically on install
    [med] LW008-PHANTOM package.json — declared dependency "dep-b" (^1.0.0) is never imported in 2 JS/TS files (plain-crypto-js pattern)

  dep-b@1.0.0 — grade F
    [critical] LW006D-PATCH-DEP-INTRODUCED — new transitive dependency dep-b@1.0.0 entered the tree alongside patch bump(s): dep-a 1.0.0 → 1.0.1
```

## Interpreting delta findings

The signal code tells you *what kind* of fact fired; the `D` suffix tells you it's a
**delta** — new in this version. That distinction is the whole review:

| You see | It means | Typical verdict |
| --- | --- | --- |
| `LW001-LIFECYCLE` (med) | The package has a postinstall — and its previous version did too. | Normal for build-tooling; note it, move on. |
| `LW001D-LIFECYCLE-INTRODUCED` (**critical**) | This *version bump added* an install script that wasn't there before. | Stop. Read the script. A patch/minor that suddenly needs install-time execution is the classic 2026 attack shape. |
| `LW002-BINDING-GYP` (low) | Native package, has always compiled at install. | Expected for `node-gyp` packages. |
| `LW002D-BINDING-GYP-INTRODUCED` (**critical**) | A build hook *appeared* — it runs at install even under `ignore-scripts=true`. | Stop. This was the node-ipc May 2026 delivery vector. |
| `LW006D-PATCH-DEP-INTRODUCED` (**critical**) | A *new* transitive package entered the tree via a patch/minor bump. | Stop. Why does a patch need a new dependency? This was the axios/`plain-crypto-js` shape. |
| `LW005D-SIZE-INTRODUCED` (high) | The main file grew >5× vs the previous version. | Inspect. Combined with new obfuscation it elevates to Critical (the node-ipc shape). |

The full signal table, weights, and elevation rules are in [Scoring](/scoring/). The key
principle: **existing surface is context, introduced surface is the alarm** — that's why
the same postinstall is `med` as an absolute finding but Critical as a delta.

When a Critical delta fires on a legitimate change (it happens — a package genuinely
going native, a maintainer restructuring deps), you'll usually confirm it in a minute:
the diff on the package's repo matches the finding, the changelog mentions it, the new
script is readable. What you're ruling out is surface that *nobody mentions anywhere*.

## The `ignore-scripts` allowlist workflow

The strongest default against install-time payloads is disabling lifecycle scripts
globally:

```ini
# .npmrc
ignore-scripts=true
```

The catch: some dependencies genuinely need their scripts (native builds, postinstall
codegen). lockwarden tells you **which ones those actually are** — every package with a
lifecycle script in your tree shows up in a plain audit as `LW001-LIFECYCLE`:

```bash
npx lockwarden audit --json \
  | jq -r '.packages[] | select(any(.findings[]; .signal?.code == "LW001-LIFECYCLE")) | .key'
```

```
with-post@1.0.0
```

That list is your allowlist: keep `ignore-scripts=true`, then rebuild/allow just those
packages explicitly (e.g. `npm rebuild <pkg>` in a controlled step, or a scripts
allowlist if your package manager supports one — pnpm's
`onlyBuiltDependencies`, for instance). Re-run the jq one-liner after dependency changes
to see when the allowlist needs updating. Remember the limits of the trick:
[`binding.gyp` hooks fire even with scripts disabled](/scoring/#layer-1--execution-surface-signals)
— which is exactly why lockwarden treats a newly-introduced one as Critical.

## `drift --base` before merging

`audit --diff` scores what changed packages can *execute*. Its companion,
[`drift`](/commands/drift/), checks whether the **lockfile itself** changed in ways the
manifest doesn't explain:

```bash
npx lockwarden drift --base main
```

```
drift vs 'main' — critical 1 · high 1
lockfile: package-lock.json

  [critical] integrity-swap  nested-lib@3.0.1
       integrity hash changed for unchanged version nested-lib@3.0.1
       ...

  [high] resolved-url-move  other-lib@2.0.0
       other-lib@2.0.0 tarball host moved registry.npmjs.org → registry.evil-mirror.example for an unchanged version
       ...
```

An integrity hash that changed for an *unchanged version*, or a tarball host that moved,
is not something Renovate does — it's something tampering does. Run both commands on
every dependency PR; they're cheap and they answer different questions:

```bash
npx lockwarden audit --diff main --ci && npx lockwarden drift --base main --ci
```

## Making it automatic

Manual review doesn't scale past a handful of repos. Wire the same two commands into
your CI so every lockfile-touching PR gets them:

- Five-minute setup: [CI quickstart](/quickstart-ci/)
- Full pipelines (GitHub, GitLab, CircleCI, Jenkins, generic): [CI recipes](/guides/ci-recipes/)
- GitHub-native with Security-tab findings: [GitHub Action](/github-action/)

## See also

- [`audit` reference](/commands/audit/) — all modes, flags, captured output.
- [`drift` reference](/commands/drift/) — every anomaly kind it detects.
- [Scoring](/scoring/) — why delta findings outweigh absolute ones.
- [Incident response](/guides/incident-response/) — when review turns into response.
