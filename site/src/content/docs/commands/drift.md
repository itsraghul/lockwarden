---
title: lockwarden drift
description: Lockfile and version-anomaly detection against a base ref — catch lockfile-only tampering that the manifest doesn't explain.
---

Lockfile & version-anomaly detection vs a base ref.

## Synopsis

```bash
npx lockwarden drift [--base <ref>]
```

`drift` answers: *did my lockfile change in ways my manifest doesn't explain?* It compares
the current lockfile against a git ref and flags:

- **Resolved version changes not explained by `package.json` changes** — lockfile-only
  tampering.
- **Registry / tarball URL changes** — the source of a resolved integrity hash moved.
- **Integrity hash changes for an unchanged version** — the same version now has
  different bytes.
- **New packages entering via patch/minor bumps** of existing dependencies.

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--base <ref>` | `main` | Git ref to compare the lockfile against |

All [global flags](/getting-started/#global-flags) apply.

## Examples

```bash
npx lockwarden drift                    # compare against main
npx lockwarden drift --base origin/main
npx lockwarden drift --base v1.4.0 --json
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No anomalies at or above `--threshold` |
| `1` | Anomalies at or above `--threshold` |
| `2` | Execution error — unknown ref, lockfile missing at the base ref, unparseable lockfile |

## A note on provenance

`drift` deliberately does **not** treat SLSA provenance as a pass signal. The June 2026
Miasma compromise published Trojanized packages *with valid provenance* from the victim's
own hijacked pipeline. Provenance presence is reported as informational context, never as
a green light — version-to-version anomaly is the honest signal.

## Notes

- `drift` reads git locally; it makes no network calls.
- Pair it with [`audit --diff`](/commands/audit/) in PR review: `drift` catches lockfile
  tampering, `audit --diff` scores what the changed packages can newly execute.
