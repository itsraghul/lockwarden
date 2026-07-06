---
title: Incident bundles
description: Vendored IOC bundles for named supply-chain incidents — the bundle JSON schema, the shipped bundles, staging your own with LOCKWARDEN_INCIDENT_DIR, and validation.
---

When a supply-chain incident hits the news, thousands of teams scramble through the same
hours-long question: *are we resolving the compromised versions?* Incident bundles turn
that into a one-liner:

```bash
npx lockwarden check --incident node-ipc-may26
```

## What a bundle is

An incident IOC bundle is a small JSON document — an incident id, a human-readable
summary, references, the affected package + version list, and optionally file-level
IOCs. [`check --incident`](/commands/check/) matches the package list against your
**resolved lockfile**, including every transitive path, and exits `1` if anything
matches. [`scan`](/commands/scan/) additionally matches `fileIocs` sha256 hashes against
file *contents* inside artifacts.

Bundles ship **vendored inside the npm package**. Running an incident check requires
zero network, zero account, and works in airgapped CI.

## Vendored bundles

| Incident id | What happened |
| --- | --- |
| `axios-mar26` | Phantom transitive dep `plain-crypto-js` ran a postinstall payload, then replaced its own files with clean decoys — visible only in the lockfile, never in `package.json`. One variant shipped pre-baked in vendored `node_modules`. |
| `node-ipc-may26` | Malicious payload delivered via a `binding.gyp` node-gyp hook at install time (executes even with lifecycle scripts disabled); published across multiple major version lines simultaneously to maximise semver-range blast radius. |
| `shai-hulud-jun26` | Worm family that evolved from lifecycle scripts to AI-agent SessionStart hooks, IDE folder-open tasks, and node-gyp — moving faster than known-bad databases could update. |

Run `npx lockwarden check --incident <id>` with any id above. An unknown id exits `2`
and lists the available bundles.

## Bundle schema

The canonical JSON Schema lives in the repo at
[`packages/cli/src/data/incidents/_schema.json`](https://github.com/itsraghul/lockwarden/blob/main/packages/cli/src/data/incidents/_schema.json).
Field by field:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string, `^[a-z0-9][a-z0-9-]*$` | yes | Stable incident id used by `check --incident <id>`, e.g. `node-ipc-may26` |
| `name` | string | yes | Human-readable incident name |
| `date` | string (ISO date) | yes | Incident date |
| `summary` | string | yes | One-paragraph description, printed by `check --incident` |
| `references[]` | string (URI) array | no | Advisories, write-ups |
| `packages[]` | array, min 1 | yes | Affected packages |
| `packages[].name` | string | yes | Package name |
| `packages[].versions[]` | string array | no | Exact compromised versions |
| `packages[].ranges[]` | string array | no | Semver ranges — for incidents published across whole version lines |
| `fileIocs[]` | array | no | On-disk indicators, matched by [`scan`](/commands/scan/) |
| `fileIocs[].path` | string | yes (in entry) | Payload filename (informational; matching is by content) |
| `fileIocs[].sha256` | string, 64 hex chars | yes (in entry) | sha256 of the payload file's contents |

No other fields are accepted (`additionalProperties: false`). A minimal, valid bundle:

```json
{
  "id": "internal-2026-07",
  "name": "Internal registry compromise (July 2026)",
  "date": "2026-07-04",
  "summary": "Compromised internal package shipped a postinstall payload.",
  "packages": [
    { "name": "acme-utils", "versions": ["2.4.1", "2.4.2"] },
    { "name": "acme-core", "ranges": [">=3.0.0 <3.0.5"] }
  ]
}
```

## Staging your own bundles: `LOCKWARDEN_INCIDENT_DIR`

Set `LOCKWARDEN_INCIDENT_DIR` to a directory of bundle JSON files to make additional
incidents available locally:

```bash
LOCKWARDEN_INCIDENT_DIR=./our-bundles npx lockwarden check --incident internal-2026-07
```

Local bundles are **added to** the vendored set (a local bundle with the same id takes
precedence for that id, but the directory never replaces the vendored bundles). Files
must end in `.json`; filenames starting with `_` are ignored (reserved for schema
files). Use it to:

- stage a bundle for a breaking incident before the patch release ships,
- encode organisation-internal incidents,
- test bundle authoring.

### Walkthrough: author, validate, use

1. **Write the bundle** to `./our-bundles/internal-2026-07.json` (as above). Keep the
   `id` matching the filename by convention.
2. **Self-test it** the same way the release pipeline does — a hit tree must exit `1`,
   a clean tree must exit `0`:
   ```bash
   cd some-repo-that-resolves-acme-utils
   LOCKWARDEN_INCIDENT_DIR=../our-bundles npx lockwarden check --incident internal-2026-07 --ci
   echo $?   # expect 1
   cd ../some-clean-repo
   LOCKWARDEN_INCIDENT_DIR=../our-bundles npx lockwarden check --incident internal-2026-07 --ci
   echo $?   # expect 0
   ```
   A malformed bundle or unknown id exits `2` — [never treat `2` as clean](/reference/exit-codes/).
   (Working in the lockwarden repo itself, `scripts/validate-incident-bundle.ts` runs
   this same gate automatically — see
   [CONTRIBUTING](https://github.com/itsraghul/lockwarden/blob/main/docs/CONTRIBUTING.md).)
3. **Fan it out**: the environment variable composes with everything —
   [`--json`](/reference/json-output/#lockwarden-check---json), `--ci`, multiple
   `--dir`, the [incident-bridge scripts](/guides/incident-response/#exit-codes-for-your-incident-bridge).

## The release cadence *is* the data pipeline

lockwarden has no backend, so there is no feed to poll. When a major incident lands, a
new IOC bundle is cut and published as an **npm patch release, typically within hours**
— an automated workflow takes the bundle JSON through schema validation, the
hit/clean self-test, and a regression gate, then publishes to npm (the one-liner works
worldwide immediately) and lands the commit through a PR. Updating is just running the
latest version, which `npx` does by default. The same mechanism refreshes the vendored
OSV snapshot used by the [Layer-2 overlay](/scoring/#layer-2--known-bad-overlay) — on a
weekly schedule, automatically: the refresh keeps the largest recency window of OSV.dev
npm malicious-package entries that fits a fixed size budget, always preserving the
canonical incident entries. Freshness is visible in every report (`advisories` dates)
and enforceable in CI via `--max-advisory-age <days>` (exit 2 when your installed
lockwarden's data is older). Note the age basis is the OSV snapshot's generation date,
not incident dates — incidents are event-dated, and a quiet month is not stale data.

This is a deliberate trade: you get auditable, versioned, reproducible advisory data (a
bundle is a diffable JSON file in a release published with npm provenance) instead of an
opaque live endpoint that malware can block — as 2026 CI-targeting malware demonstrably
does to hosted security agents. Full rationale:
[architecture decisions](/project/architecture-decisions/#3-structural-detection-primary-feeds-vendored-and-secondary).

## See also

- [Incident response runbook](/guides/incident-response/) — bundles in the full
  triage flow.
- [`check` reference](/commands/check/) — flags and captured output.
- [`scan` reference](/commands/scan/#example-3--file-level-ioc-match) — `fileIocs`
  matching in artifacts.
