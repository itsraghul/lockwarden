---
title: lockwarden check
description: Incident triage — report every path by which a package enters the tree, check named incident bundles, and walk historical exposure windows from git.
---

Incident triage: report every path by which a package enters the tree.

## Synopsis

```bash
npx lockwarden check <pkg>@<version> [<pkg>@<version> ...]
npx lockwarden check --incident <incident-id>
npx lockwarden check <pkg> --history
```

`check` resolves your query against the **lockfile** — including all transitive
resolutions — and reports every path by which a matching package enters the tree. This is
the difference that matters during incidents: teams pinned to `^9` got node-ipc's payload
automatically on their next install, and `package.json` never showed it.

## Arguments

| Argument | Meaning |
| --- | --- |
| `queries...` | Package queries: `<pkg>`, `<pkg>@<version>`, or `<pkg>@<range>` |

## Flags

| Flag | Meaning |
| --- | --- |
| `--incident <id>` | Check against a vendored incident IOC bundle |
| `--history` | Walk git history of the lockfile to report exposure windows |

All [global flags](/getting-started/#global-flags) apply.

## Examples

```bash
# Exact version — am I resolving this right now?
npx lockwarden check node-ipc@9.1.6

# Range — everything that could match a compromised line
npx lockwarden check "node-ipc@>=9.1.6 <9.1.7"

# Named incident bundle (see the incidents reference for available ids)
npx lockwarden check --incident shai-hulud-jun26

# Historical exposure: was this repo *ever* resolving a hit, and in
# which commit window? Derived locally from git log — no service needed.
npx lockwarden check axios --history

# CI-friendly machine output
npx lockwarden check --incident axios-mar26 --json --ci
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No queried package (or incident package) resolves anywhere in the tree |
| `1` | At least one match found in the resolved tree |
| `2` | Execution error (no lockfile, bad query, missing git history for `--history`) |

## Notes

- `--history` needs the lockfile to be tracked in git; it reads `git log` locally and
  never contacts a remote.
- `--incident` bundles ship vendored inside the npm package — running a check requires
  zero network. See [incident bundles](/incidents/) for the list and the
  `LOCKWARDEN_INCIDENT_DIR` escape hatch.
- `--json` emits a stable machine-readable report of every match and its dependency
  paths, suitable for piping into other tooling.
