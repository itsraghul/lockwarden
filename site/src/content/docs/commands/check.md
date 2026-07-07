---
title: lockwarden check
description: Incident triage — report every path by which a package enters the tree, check named incident bundles, and walk historical exposure windows from git.
---

Incident triage: report every path by which a package enters the resolved tree.

## Synopsis

```bash
lockwarden check [queries...]
lockwarden check --incident <id>
lockwarden check <pkg> --history
```

```
Usage: lockwarden check [options] [queries...]

incident triage: report every path by which a package enters the tree

Arguments:
  queries          package queries: <pkg>, <pkg>@<version>, <pkg>@<range>

Options:
  --incident <id>  check against a vendored incident IOC bundle
  --history        walk git history of the lockfile to report exposure windows
  -h, --help       display help for command
```

`check` resolves your query against the **lockfile** — including all transitive
resolutions — and reports every path by which a matching package enters the tree. This is
the difference that matters during incidents: teams pinned to `^9` got node-ipc's payload
automatically on their next install, and `package.json` never showed it.

## Arguments and flags

| Argument / flag | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queries...` | string list | — | Package queries: `<pkg>` (all resolved versions), `<pkg>@<version>` (exact), or `<pkg>@<range>` (semver range) |
| `--incident <id>` | string | — | Check against an [incident IOC bundle](/incidents/) instead of ad-hoc queries — list valid ids with [`lockwarden incidents`](/commands/incidents/) |
| `--history` | boolean | `false` | Walk git history of the lockfile to report exposure windows |

All [global flags](/getting-started/#global-flags) apply. `--dir` is repeatable and
`check` reports **per directory** — one command can triage every workspace of a
monorepo.

## Example 1 — exact version, transitive hit

```bash
npx lockwarden check evil-pkg@1.2.3
```

```
lockfile: package-lock.json (npm)
  HIT  evil-pkg@1.2.3
       project → app-lib@1.0.0 → evil-pkg@1.2.3
       project → other-lib@2.0.0 → nested-lib@3.0.1 → evil-pkg@1.2.3
```

Exit `1`. Each indented line is one complete dependency path from your project root —
the first hop after `project` is the direct dependency you control. Paths are enumerated
via a cycle-safe reverse walk of the resolution graph, capped at 500 per package
(`truncated: true` in JSON if the cap is hit). A miss exits `0`:

```
lockfile: package-lock.json (npm)
  clean  not-here@1.0.0 — not in the resolved tree
```

## Example 2 — bare name and semver ranges

A bare name matches **every** resolved version — useful when a whole package is
compromised or you just want to know what you're running:

```bash
npx lockwarden check evil-pkg
```

```
lockfile: package-lock.json (npm)
  HIT  evil-pkg@1.2.3
       project → app-lib@1.0.0 → evil-pkg@1.2.3
       project → other-lib@2.0.0 → nested-lib@3.0.1 → evil-pkg@1.2.3
  HIT  evil-pkg@2.0.0
       project → modern-lib@4.0.0 → evil-pkg@2.0.0
```

Note the two `HIT` blocks: npm trees routinely resolve **multiple versions of the same
package** at different nesting levels — exactly what manifest-level checking misses.
Ranges work too (quote them for your shell):

```bash
npx lockwarden check "evil-pkg@^1.0.0"
npx lockwarden check "node-ipc@>=9.1.6 <9.1.7"
```

## Example 3 — named incident bundle

```bash
npx lockwarden check --incident node-ipc-may26
```

```
incident  node-ipc binding.gyp compromise (May 2026) (node-ipc-may26, 2026-05-12)
Malicious payload delivered via a binding.gyp node-gyp hook that executes at install time even with lifecycle scripts disabled; CI credentials harvested. Published across multiple major version lines simultaneously to maximize semver-range blast radius.

lockfile: package-lock.json (npm)
  clean  node-ipc@9.1.6 — not in the resolved tree
  clean  node-ipc@9.2.3 — not in the resolved tree
  clean  node-ipc@12.0.1 — not in the resolved tree
```

Bundles ship vendored in the npm package — zero network. An unknown id exits `2` and
lists the available bundles. Stage pre-release or internal bundles with
`LOCKWARDEN_INCIDENT_DIR` — see [incident bundles](/incidents/).

## Example 4 — historical exposure with `--history`

```bash
npx lockwarden check evil-pkg --history
```

```
history of package-lock.json — 3 commits examined
  EXPOSED  evil-pkg
       1.2.3: from 2026-07-05T16:24:20+05:30 (1f9292d2) until 2026-07-05T16:24:20+05:30 (1f9292d2)
       2.0.0: from 2026-07-05T16:24:20+05:30 (1f9292d2) until 2026-07-05T16:24:47+05:30 (1c58e2eb)
       1.2.4: from 2026-07-05T16:24:47+05:30 (1c58e2eb) until 2026-07-05T16:24:47+05:30 (1c58e2eb)
```

Each line is an exposure window for one resolved version: first commit that resolved it
→ last commit that did. lockwarden reparses the lockfile at each historical revision —
entirely from local `git log`, no remote contact. How to act on windows:
[incident response, step 3](/guides/incident-response/#step-3--were-we-ever-exposed----history).

## `--json` output

```bash
npx lockwarden check evil-pkg@1.2.3 --json
```

```json
{
  "command": "check",
  "dirs": [
    {
      "dir": "/work/app",
      "lockfile": { "path": "/work/app/package-lock.json", "type": "npm" },
      "warnings": [],
      "queries": [
        {
          "query": "evil-pkg@1.2.3",
          "hit": true,
          "matches": [
            {
              "name": "evil-pkg",
              "version": "1.2.3",
              "devOnly": false,
              "truncated": false,
              "paths": [
                ["<root>", "app-lib@1.0.0", "evil-pkg@1.2.3"],
                ["<root>", "other-lib@2.0.0", "nested-lib@3.0.1", "evil-pkg@1.2.3"]
              ]
            }
          ]
        }
      ]
    }
  ],
  "hit": true,
  "exitCode": 1
}
```

Field-by-field reference (including the `--incident` and `--history` variants):
[JSON output → check](/reference/json-output/#lockwarden-check---json).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No queried package (or incident package) resolves anywhere in the tree |
| `1` | At least one match found in the resolved tree |
| `2` | Execution error — no/unparseable lockfile, bad query, unknown incident id, missing git history for `--history` |

## Notes

- `check` performs **no network calls**, ever — vendored bundles, local lockfile, local
  git. `--offline` is always satisfied.
- `--history` needs the lockfile to be tracked in git.
- Queries against `yarn.lock` and `pnpm-lock.yaml` work identically — all parsers
  normalize to the same resolution graph.
- `--max-advisory-age` applies **only to `--incident`** (the one mode that reads
  vendored advisory data). Plain queries and `--history` never fail on staleness —
  the incident-day `npx lockwarden check bad-pkg@1.2.3` one-liner must always work,
  even from an old pinned install.

## See also

- [Incident response runbook](/guides/incident-response/) — `check` in anger, including
  fan-out scripts for many repos.
- [Incident bundles](/incidents/) — bundle ids, schema, `LOCKWARDEN_INCIDENT_DIR`.
- [`audit`](/commands/audit/) — when the question is *what can this tree execute*, not
  *is this package in it*.
- [Exit codes](/reference/exit-codes/) — wiring `check` into scripts and bridges.
