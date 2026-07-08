---
title: lockwarden explain
description: Explain a finding code — what it detects, why it is weighted the way it is, and what to do about it. Vendored knowledge, fully offline.
---

Explain a finding code: what it detects, why it carries its weights, and what
to do when it fires. The knowledge is vendored — fully offline — and the
weights are read live from the corpus-locked table, so `explain` can never
disagree with what `audit` actually scores.

## Synopsis

```bash
lockwarden explain              # list every finding code
lockwarden explain <code>       # one code in detail
```

```
Usage: lockwarden explain [options] [code]

explain a finding code: what it detects, its weights, what to do

Arguments:
  code        e.g. LW001, LW001-LIFECYCLE, lifecycle-scripts, LW2-OSV; omit to list all

Options:
  -h, --help  display help for command
```

`<code>` accepts any spelling a report emits or a human remembers: the family
id (`LW001`), the full absolute or delta code (`LW001-LIFECYCLE`,
`LW001D-LIFECYCLE-INTRODUCED`), the analyzer id (`lifecycle-scripts`), or a
Layer-2 code (`LW2-OSV`, `LW2-IOC-<incident-id>`). Case-insensitive. Always
exits `0`; an unknown code is exit `2` with the list of valid ones.

## Example — a structural code

```
$ lockwarden explain LW006
LW006 — new transitive dep in a patch release [dep-introduction]
  absolute: — · delta: critical (F)
  codes: LW006D-PATCH-DEP-INTRODUCED

  detects: A brand-new transitive dependency appearing in a semver PATCH release of a package (delta modes only).
  why it matters: Patch releases promise "no new behavior" — smuggling a new dependency into one is how droppers arrive (the axios-mar26 phantom dep entered a tree this way). Corpus run: zero benign occurrences across 496 real version bumps.
  what to do: Look up the introduced package (`lockwarden check <pkg>` shows every path). If its existence surprises you, hold the upgrade and check the introduced package against advisories.

  docs: https://lockwarden.dev/scoring/
```

## Example — a full Layer-2 code

Paste the exact code from a report and `explain` also resolves the advisory it
points at (when the id ships in your installed version's data):

```
$ lockwarden explain LW2-IOC-node-ipc-may26
LW2-IOC — incident IOC match
  always critical (grade F) on any hit
  ...
  matched incident advisory: node-ipc-may26 — packages: node-ipc
  Malicious payload delivered via a binding.gyp node-gyp hook that executes at install time even with lifecycle scripts disabled; CI credentials harvested. ...
```

With `--ci`, only the header lines (weights + codes) print. `--json` emits a
stable shape — see the [JSON output reference](/reference/json-output/#lockwarden-explain---json).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Always — the explanation is informational |
| `2` | Unknown finding code |

## See also

- [Scoring](/scoring/) — the full model these codes come from.
- [`incidents`](/commands/incidents/) — the bundles behind `LW2-IOC-*` codes.
- [Baseline](/commands/audit/#baseline) — accepting a reviewed finding.
