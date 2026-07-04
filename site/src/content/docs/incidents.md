---
title: Incident bundles
description: Vendored IOC bundles for named supply-chain incidents — what they are, which ship today, and how the npm release cadence is the data pipeline.
---

When a supply-chain incident hits the news, thousands of teams scramble through the same
hours-long question: *are we resolving the compromised versions?* Incident bundles turn
that into a one-liner:

```bash
npx lockwarden check --incident node-ipc-may26
```

## What a bundle is

An incident IOC bundle is a small JSON document — an incident id, a human-readable
summary, references, and the affected `package` + version-range list (optionally
file-level IOCs). `check --incident` matches the bundle against your **resolved
lockfile**, including every transitive path, and exits `1` if anything matches.

Bundles ship **vendored inside the npm package**. Running an incident check requires zero
network, zero account, and works in airgapped CI.

## Vendored bundles

| Incident id | What happened |
| --- | --- |
| `axios-mar26` | Phantom transitive dep `plain-crypto-js` ran a postinstall payload, then replaced its own files with clean decoys — visible only in the lockfile, never in `package.json`. |
| `node-ipc-may26` | Malicious payload delivered via a `binding.gyp` node-gyp hook at install time; published across multiple major version lines simultaneously to maximise semver-range blast radius. |
| `shai-hulud-jun26` | Worm family that evolved from lifecycle scripts to AI-agent SessionStart hooks, IDE folder-open tasks, and node-gyp — moving faster than known-bad databases could update. |

Run `npx lockwarden check --incident <id>` with any id above. An unknown id exits `2`
and lists the available bundles.

## The release cadence *is* the data pipeline

lockwarden has no backend, so there is no feed to poll. When a major incident lands, a new
IOC bundle is cut and published as an **npm patch release within hours** — updating is
just running the latest version, which `npx` does by default. The same mechanism refreshes
the vendored OSV snapshot used by the Layer-2 overlay (see [Scoring](/scoring/)).

This is a deliberate trade: you get auditable, versioned, reproducible advisory data (a
bundle is a diffable JSON file in a signed release) instead of an opaque live endpoint
that malware can block — as 2026 CI-targeting malware demonstrably does to hosted
security agents.

## Staging your own bundles: `LOCKWARDEN_INCIDENT_DIR`

Set the `LOCKWARDEN_INCIDENT_DIR` environment variable to a directory of bundle JSON
files to make additional incidents available locally:

```bash
LOCKWARDEN_INCIDENT_DIR=./our-bundles npx lockwarden check --incident internal-2026-07
```

Local bundles are **added to** the vendored set (a local bundle with the same id takes
precedence for that id, but the directory never replaces the vendored bundles). Use it to:

- stage a bundle for a breaking incident before it ships in a release,
- encode organisation-internal incidents,
- test bundle authoring.

Files must end in `.json`; filenames starting with `_` are ignored (reserved for schema
files).
