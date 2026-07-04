---
title: lockwarden scan
description: Execution-surface scan of an artifact — tarball, zip, directory, or docker-save image. Audits what is actually on disk, not what a manifest claims.
---

Execution-surface scan of an artifact: tarball, zip, directory, or docker-save image.

## Synopsis

```bash
npx lockwarden scan <artifact-path>
npx lockwarden scan --image <docker-image>
```

`scan` applies the same Layer-1 execution-surface analysis and Layer-2 known-bad matching
as [`audit`](/commands/audit/) — but to what is **actually on disk** inside an artifact,
not what a manifest claims. This catches the vector no registry-level scanner ever sees:
tampered dependencies shipped pre-baked inside vendored `node_modules` (as one variant of
the March 2026 Axios incident did).

## Arguments & flags

| | Meaning |
| --- | --- |
| `artifact` | Path to a tarball, zip, or directory artifact |
| `--image <docker-image>` | Scan a docker image (extracted via `docker save` — no daemon API dependency) |
| `--verbose` | Include Low findings in SARIF output |

All [global flags](/getting-started/#global-flags) apply.

## Examples

```bash
# The release tarball you are about to publish
npx lockwarden scan ./myapp-1.2.0.tgz

# A vendored directory
npx lockwarden scan ./vendor/

# The image you are about to deploy — scans node_modules in the layers
npx lockwarden scan --image myapp:latest

# CI pre-deploy gate
npx lockwarden scan --image myapp:latest --ci --sarif
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No findings at or above `--threshold` |
| `1` | Findings at or above `--threshold` |
| `2` | Execution error — artifact not found or unreadable, `docker save` failed |

## Notes

- `scan` performs **no network calls**. `--offline` is always satisfiable here.
- Docker scanning parses the `docker save` tarball layer by layer; it does not talk to a
  Docker daemon API.
- Findings map to SARIF exactly as in `audit` — Critical→`error`, High→`warning`,
  Med→`note`, Low suppressed unless `--verbose`.
