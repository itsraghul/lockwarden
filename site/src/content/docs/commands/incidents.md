---
title: lockwarden incidents
description: List the incident IOC bundles this build knows about — the valid ids for check --incident, with dates, package counts, and file-IOC counts.
---

List the incident IOC bundles this build of lockwarden knows about — i.e. every
valid id for [`check --incident <id>`](/commands/check/).

## Synopsis

```bash
lockwarden incidents
```

```
Usage: lockwarden incidents [options]

list the incident bundles this build knows (for check --incident <id>)

Options:
  -h, --help  display help for command
```

Purely informational: reads zero network, zero lockfiles, and always exits `0`
(`2` only on execution errors). Because advisory data is
[vendored](/trust-model/), the listing tells you exactly what *your installed
version* can match — during an incident, `npx lockwarden@latest incidents`
shows whether the bundle you need has shipped yet.

## Example

```
$ lockwarden incidents
3 incident bundles · OSV snapshot 2026-07-07 (5601 entries, 6mo window)

  shai-hulud-jun26 — Shai-Hulud / node-gyp worm wave (Jun 2026) (2026-06-09)
      2 package(s)
      Worm family that evolved from lifecycle scripts to AI-agent SessionStart hooks and IDE folder-open tasks, then to node-gyp build hooks (57 packages in the June wave). Moved faster than known-bad databases could update. SEED LIST — partial; refresh this bundle from the public IOC feed before relying on it.
      npx lockwarden check --incident shai-hulud-jun26

  node-ipc-may26 — node-ipc binding.gyp compromise (May 2026) (2026-05-12)
      1 package(s)
      Malicious payload delivered via a binding.gyp node-gyp hook that executes at install time even with lifecycle scripts disabled; CI credentials harvested. Published across multiple major version lines simultaneously to maximize semver-range blast radius.
      npx lockwarden check --incident node-ipc-may26

  axios-mar26 — Axios phantom transitive dep — plain-crypto-js (Mar 2026) (2026-03-18)
      1 package(s)
      Phantom transitive dependency plain-crypto-js ran a postinstall payload, then replaced its own files with clean decoys. Only visible in the lockfile, never in package.json. One variant shipped the tampered code pre-baked in vendored node_modules.
      npx lockwarden check --incident axios-mar26
```

Bundles are listed newest first. The summary line doubles as an advisory-data
overview (the same OSV snapshot date that `--max-advisory-age` enforces). With
`--ci`, only the summary line prints.

Bundles staged via `LOCKWARDEN_INCIDENT_DIR` (a local overlay used to test a
bundle before it ships in a release) are marked `[local overlay]`.

## `--json` output

See the [JSON output reference](/reference/json-output/#lockwarden-incidents---json).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Always — the listing is informational |
| `2` | Execution error, e.g. a malformed `LOCKWARDEN_INCIDENT_DIR` bundle |

## See also

- [Incident bundles](/incidents/) — what a bundle contains and how one ships.
- [`check --incident`](/commands/check/#example-3--named-incident-bundle) — the
  triage one-liner these ids feed.
- [Incident response](/guides/incident-response/) — the full runbook.
