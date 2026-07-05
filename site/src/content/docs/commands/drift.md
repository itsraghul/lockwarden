---
title: lockwarden drift
description: Lockfile and version-anomaly detection against a base ref — integrity swaps, resolved-URL moves, unexplained version changes, and patch-introduced packages.
---

Lockfile & version-anomaly detection vs a base ref.

## Synopsis

```bash
lockwarden drift [--base <ref>]
```

```
Usage: lockwarden drift [options]

lockfile & version-anomaly detection vs a base ref

Options:
  --base <ref>  git ref to compare the lockfile against (default: "main")
  -h, --help    display help for command
```

`drift` answers: *did my lockfile change in ways my manifest doesn't explain?* It
compares the working lockfile against the one committed at `--base` and flags anomalies —
the tampering patterns that never show up in a normal dependency bump.

## Flags

| Flag | Type | Default | Meaning |
| --- | --- | --- | --- |
| `--base <ref>` | string | `main` | Git ref to compare the lockfile against |

All [global flags](/getting-started/#global-flags) apply.

## What it detects

| Finding kind | Severity | What it means |
| --- | --- | --- |
| `integrity-swap` | **critical** | The integrity hash changed for an *unchanged* version — the same `name@version` now points at different bytes |
| `unexplained-version` | high | A resolved version changed with no corresponding `package.json` change to explain it — lockfile-only tampering |
| `resolved-url-move` | high (host move) / med | The tarball URL for an unchanged version moved — high when the *host* changed |
| `patch-introduced-dep` | high | A new package entered the tree alongside patch/minor bumps of existing dependencies |

## Example 1 — tampered lockfile

```bash
npx lockwarden drift --base main
```

```
drift vs 'main' — critical 1 · high 1
lockfile: package-lock.json

  [critical] integrity-swap  nested-lib@3.0.1
       integrity hash changed for unchanged version nested-lib@3.0.1
       baseIntegrity: sha512-N1yzAAA0aaaBBBbbbCCCcccDDDdddEEEeeeFFFfffGGGgggHHHhhhIIIiiiJJJjjjKKKkkkLLLlllMMAA==
       currentIntegrity: sha512-TAMPEREDaaaBBBbbbCCCcccDDDdddEEEeeeFFFfffGGGgggHHHhhhIIIiiiJJJjjjKKKkkkLLLlllMMAA==

  [high] resolved-url-move  other-lib@2.0.0
       other-lib@2.0.0 tarball host moved registry.npmjs.org → registry.evil-mirror.example for an unchanged version
       baseResolved: https://registry.npmjs.org/other-lib/-/other-lib-2.0.0.tgz
       currentResolved: https://registry.evil-mirror.example/other-lib/-/other-lib-2.0.0.tgz

note: provenance is informational only — valid provenance has shipped from compromised pipelines
```

Exit `1`. Neither of these happens in a legitimate bump: same version + different hash
means different bytes; same version + different host means a different source of truth.

## Example 2 — a dependency PR that smuggles a package in

```bash
npx lockwarden drift --base main
```

```
drift vs 'main' — high 1
lockfile: package-lock.json

  [high] patch-introduced-dep  dep-b@1.0.0
       new package dep-b@1.0.0 entered the tree alongside patch/minor bump(s): dep-a 1.0.0 → 1.0.1
       bumps: dep-a 1.0.0 → 1.0.1

note: provenance is informational only — valid provenance has shipped from compromised pipelines
```

A patch release that brings a *new* dependency with it is the axios/`plain-crypto-js`
delivery shape. [`audit --diff`](/commands/audit/) scores the same event from the
execution-surface side (`LW006D-PATCH-DEP-INTRODUCED`, Critical) — run both on
dependency PRs; see [dependency review](/guides/dependency-review/#drift---base-before-merging).

## Example 3 — clean

```bash
npx lockwarden drift --base origin/main
```

```
drift vs 'origin/main' — no findings
lockfile: package-lock.json
  clean  no lockfile drift vs 'origin/main'

note: provenance is informational only — valid provenance has shipped from compromised pipelines
```

Exit `0`. Other useful refs:

```bash
npx lockwarden drift --base v1.4.0 --json     # since the last release, machine-readable
npx lockwarden drift --base HEAD~5            # the last five commits
```

## `--json` output

```json
{
  "command": "drift",
  "base": "main",
  "lockfile": { "path": "/work/app/package-lock.json", "type": "npm" },
  "findings": [
    {
      "kind": "integrity-swap",
      "severity": "critical",
      "package": "nested-lib@3.0.1",
      "detail": "integrity hash changed for unchanged version nested-lib@3.0.1",
      "evidence": {
        "baseIntegrity": "sha512-N1yz…",
        "currentIntegrity": "sha512-TAMP…"
      }
    }
  ],
  "warnings": [],
  "exitCode": 1
}
```

Field tables: [JSON output → drift](/reference/json-output/#lockwarden-drift---json).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No anomalies at or above `--threshold` |
| `1` | Anomalies at or above `--threshold` |
| `2` | Execution error — unknown ref, lockfile missing at the base ref, unparseable lockfile |

## A note on provenance

`drift` deliberately does **not** treat SLSA provenance as a pass signal — every run
prints the reminder. The June 2026 Miasma compromise published trojanized packages *with
valid provenance* from the victim's own hijacked pipeline. Provenance presence is
informational context, never a green light — version-to-version anomaly is the honest
signal. More: [trust model](/trust-model/#provenance-is-informational--never-a-pass-signal).

## Notes

- `drift` reads git locally; it makes **no network calls**. `--offline` is always
  satisfied.
- Requires the lockfile to exist at the base ref (exit `2` otherwise).

## See also

- [`audit --diff`](/commands/audit/) — scores what changed packages can newly *execute*;
  `drift` catches changes to the lockfile *itself*.
- [Dependency review](/guides/dependency-review/) — both commands in the PR workflow.
- [Incident response](/guides/incident-response/#post-incident-pin-verify-scan) — `drift`
  as a post-incident tamper sweep.
