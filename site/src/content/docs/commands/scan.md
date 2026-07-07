---
title: lockwarden scan
description: Execution-surface scan of an artifact — tarball, zip, directory, or docker-save image. Audits what is actually on disk, including file-level incident IOCs.
---

Execution-surface scan of an artifact: tarball, zip, directory, or docker-save image.

## Synopsis

```bash
lockwarden scan <artifact-path>
lockwarden scan --image <docker-image>
```

```
Usage: lockwarden scan [options] [artifact]

execution-surface scan of an artifact: tarball, zip, dir, or docker-save image

Arguments:
  artifact                path to a tarball/zip/directory artifact

Options:
  --image <docker-image>  scan a docker image (via docker save)
  --verbose               include Low findings in SARIF output (default: false)
  --baseline <path>       baseline file (default: <dir>/.lockwarden-baseline.json)
  --no-baseline           ignore any baseline file
  --write-baseline        create/update the baseline from current findings (default: false)
  -h, --help              display help for command
```

`scan` applies the same Layer-1 execution-surface analysis and Layer-2 known-bad matching
as [`audit`](/commands/audit/) — but to what is **actually on disk** inside an artifact,
not what a manifest claims. This catches the vector no registry-level scanner ever sees:
tampered dependencies shipped pre-baked inside vendored `node_modules` (as one variant of
the March 2026 axios incident did). It also matches **file-level IOCs** (sha256 hashes of
known payload files) from [incident bundles](/incidents/).

## Arguments and flags

| Argument / flag | Type | Default | Meaning |
| --- | --- | --- | --- |
| `artifact` | string | — | Path to a tarball (`.tgz`/`.tar.gz`), zip, or directory |
| `--image <docker-image>` | string | — | Scan a docker image, extracted via `docker save` — no daemon API dependency |
| `--verbose` | boolean | `false` | Include Low findings in SARIF output |
| `--baseline <path>` | string | `<dir>/.lockwarden-baseline.json` | Baseline of accepted findings — see [Baseline](#baseline) |
| `--no-baseline` | boolean | `false` | Ignore any baseline file |
| `--write-baseline` | boolean | `false` | Create/update the baseline from current findings |

All [global flags](/getting-started/#global-flags) apply.

## Baseline

`scan` supports the same [baseline suppression as `audit`](/commands/audit/#baseline):
accept the reviewed findings of an artifact once, then fail CI only on **new** execution
surface. Same file format, same version-independent `code` + `package` matching, same
never-suppressible classes (Layer-2, Critical, delta-on-F).

One difference: an artifact is not a writable project directory, so the default baseline
path is `.lockwarden-baseline.json` in the **first `--dir`, else the current working
directory** — the project running the scan, not the artifact being scanned. Pass
`--baseline <path>` to keep separate baselines for separate artifacts.

```bash
# Review the artifact's findings, then accept them:
lockwarden scan dist/app.tgz --write-baseline

# Commit the file; from now on only NEW findings fail the run:
lockwarden scan dist/app.tgz --ci --threshold med
```

Suppressed findings stay visible — dimmed `[suppressed]` lines, a `suppressed` array in
[`--json`](/reference/json-output/), and the SARIF `suppressions` property.

## Example 1 — a release tarball with baked-in tampering

```bash
npx lockwarden scan app-baked-postinstall.tgz
```

```
grade C — 1 package flagged of 2 analyzed
med 2
artifact: app-baked-postinstall.tgz (tgz) — 2 embedded package roots

  evil-thing@1.0.1 (package/node_modules/evil-thing) — grade C
    [med] LW001-LIFECYCLE package.json — lifecycle script "postinstall" runs automatically on install
    [med] LW007-OBFUSCATION install.js — obfuscation markers in install-path file: hex-array density 111.36/KB
```

`scan` discovers every embedded package root (each `package.json` inside the artifact,
including nested `node_modules`) and analyzes each one; the path in parentheses tells
you *where inside the artifact* the flagged package lives. A clean artifact:

```
grade A — 0 packages flagged of 3 analyzed
no findings
artifact: app-clean.tgz (tgz) — 3 embedded package roots
```

## Example 2 — docker-save layers with a known-bad package

```bash
docker save myapp:latest -o myapp.tar
npx lockwarden scan myapp.tar          # or: npx lockwarden scan --image myapp:latest
```

```
grade F — 1 package flagged of 2 analyzed
critical 2
artifact: docker-save.tar (docker-save) — 2 embedded package roots

  plain-crypto-js@1.0.0 (node_modules/plain-crypto-js) — grade F
    [critical] LW2-OSV-MAL-2026-0117 — known-bad (osv: MAL-2026-0117) Phantom transitive dependency of the axios Mar 2026 compromise; every published version runs a postinstall payload then replaces its own files with clean decoys. Seed snapshot — refresh before release.
    [critical] LW2-IOC-axios-mar26 — known-bad (incident: axios-mar26) Phantom transitive dependency plain-crypto-js ran a postinstall payload, then replaced its own files with clean decoys. Only visible in the lockfile, never in package.json. One variant shipped the tampered code pre-baked in vendored node_modules.
```

Exit `1`. Layer matters here: the image's layers are replayed **later-layer-wins with
whiteouts honored**, so what gets scanned is the filesystem a container would actually
run — not stale files shadowed by later layers. `--image` shells out to `docker save`;
scanning an already-saved tar needs no docker at all.

## Example 3 — file-level IOC match

Incident bundles can carry `fileIocs` — sha256 hashes of known payload files.
`scan` matches file *contents*, so a renamed payload still hits:

```bash
npx lockwarden scan app.tgz
```

```
grade F — 1 package flagged of 2 analyzed
critical 1
artifact: app-ioc.tgz (tgz) — 2 embedded package roots

  iocpkg@1.0.0 (package/node_modules/iocpkg) — grade F
    [critical] LW2-IOC-scan-ioc-test-FILE — known-bad (incident: scan-ioc-test) file content matches incident IOC sha256 (payload.js): Local-only bundle exercising scan fileIocs sha256 matching.
```

(Output captured with a staged local bundle via `LOCKWARDEN_INCIDENT_DIR`; shipped
bundles work identically. Bundle schema: [incident bundles](/incidents/#bundle-schema).)

## More invocations

```bash
npx lockwarden scan ./vendor/                       # a vendored directory
npx lockwarden scan dist/app.zip --json             # machine-readable
npx lockwarden scan --image myapp:latest --ci --sarif   # CI pre-deploy gate
```

## `--json` output

Same report shape as `audit`, with `artifact` metadata instead of `lockfile`, and a
per-package `root` field for the location inside the artifact:

```json
{
  "command": "scan",
  "artifact": { "path": "app-baked-postinstall.tgz", "kind": "tgz", "roots": 2 },
  "packages": [
    {
      "name": "evil-thing",
      "version": "1.0.1",
      "key": "evil-thing@1.0.1",
      "grade": "C",
      "findings": [ /* same Finding shape as audit */ ],
      "root": "package/node_modules/evil-thing"
    }
  ],
  "rollup": {
    "grade": "C",
    "packagesAnalyzed": 2,
    "packagesFlagged": 1,
    "counts": { "none": 0, "low": 0, "med": 2, "high": 0, "critical": 0 }
  },
  "warnings": []
}
```

Field tables: [JSON output → scan](/reference/json-output/#lockwarden-scan---json).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No findings at or above `--threshold` |
| `1` | Findings at or above `--threshold` |
| `2` | Execution error — artifact not found or unreadable, `docker save` failed |

## Notes

- `scan` performs **no network calls**. `--offline` is always satisfiable here.
- Analysis is absolute-mode (there is no "previous version" of an artifact) plus the
  Layer-2 overlay — see [Scoring](/scoring/).
- Findings map to SARIF exactly as in `audit` — Critical→`error`, High→`warning`,
  Med→`note`, Low suppressed unless `--verbose`.
- The report carries the same `advisories` freshness dates as `audit`, and
  `--max-advisory-age` applies (the Layer-2 overlay is only as good as the vendored
  data's age).

## See also

- [Incident response](/guides/incident-response/#post-incident-pin-verify-scan) —
  scanning artifacts built during an exposure window.
- [Incident bundles](/incidents/) — how `fileIocs` get into scan's matching set.
- [`audit`](/commands/audit/) — the same analysis, driven by the lockfile instead of an
  artifact.
