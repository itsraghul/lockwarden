---
title: Incident response
description: The runbook for a trending npm supply-chain incident — triage in one line, read path traces, find exposure windows, wire exit codes into your bridge, and close out safely.
---

A supply-chain incident is trending. Package names and versions are flying around a
thread somewhere, and every team asks the same question: **are we resolving the
compromised versions — anywhere, through any path?** This runbook takes you from that
moment to a closed incident.

## Step 0 — triage, one line, no install

In each affected repo (or on your CI runner, or in a container — anywhere with the repo
checked out):

```bash
npx lockwarden check node-ipc@9.1.6
```

`npx` means no install step and, critically, the **latest** lockwarden — which matters
because incident bundles ship as npm releases (see Step 2). The answer comes from the
**resolved lockfile**, not `package.json`: teams pinned to `^9` got node-ipc's payload
on their next install while their manifest never changed.

Query forms, all accepted:

```bash
npx lockwarden check node-ipc@9.1.6              # exact version
npx lockwarden check "node-ipc@>=9.1.6 <9.1.7"   # semver range
npx lockwarden check node-ipc                     # bare name: every resolved version
npx lockwarden check pkg-a@1.0.0 pkg-b@2.1.3      # several at once
```

Clean looks like this and exits `0`:

```
lockfile: package-lock.json (npm)
  clean  node-ipc@9.1.6 — not in the resolved tree
```

## Step 1 — reading a HIT and its path traces

```
lockfile: package-lock.json (npm)
  HIT  evil-pkg@1.2.3
       project → app-lib@1.0.0 → evil-pkg@1.2.3
       project → other-lib@2.0.0 → nested-lib@3.0.1 → evil-pkg@1.2.3
```

Each line under a `HIT` is one complete dependency path from your project root to the
compromised package. Read them right-to-left to answer the two response questions:

- **How is it getting in?** The *first* hop after `project` is the direct dependency you
  control. Here, both `app-lib` and `other-lib` pull it in — pinning or removing just one
  is not enough.
- **How wide is the blast radius?** Multiple paths mean multiple direct deps need a fix
  (an override/resolution, a pin, or an upstream bump). `check` reports every path
  (capped at 500 per package, flagged as `truncated` in
  [`--json`](/reference/json-output/#lockwarden-check---json) if hit).

For a monorepo, check every workspace in one command:

```bash
npx lockwarden check evil-pkg@1.2.3 --dir packages/api --dir packages/web
```

## Step 2 — named incidents: `--incident <id>`

For major incidents you don't need to collect version lists from social media —
lockwarden ships curated IOC bundles, and one id checks the whole package set:

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

**How bundles arrive:** they ship *vendored inside the npm package* — there is no feed,
no login, no runtime API. When a new incident lands, a bundle is cut and published as an
**npm patch release, typically within hours** (an automated pipeline takes a validated
bundle JSON to a published release). Updating is just running the latest version, which
`npx` does by default. An unknown id exits `2` and lists what's available:

```
lockwarden: unknown incident id "some-other-incident"
  hint: known incidents: axios-mar26, node-ipc-may26, shai-hulud-jun26
```

**Before a bundle ships — or for internal incidents** — stage your own with
`LOCKWARDEN_INCIDENT_DIR`:

```bash
LOCKWARDEN_INCIDENT_DIR=./our-bundles npx lockwarden check --incident internal-2026-07
```

The bundle format is a small JSON file; the full schema and an authoring walkthrough are
in [incident bundles](/incidents/).

## Step 3 — "were we *ever* exposed?" — `--history`

A clean tree today doesn't mean you were never exposed. `--history` walks the local git
log of your lockfile and reports **exposure windows** per version:

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

Each window is *first commit that resolved the version* → *last commit that did*
(`stillPresent: true` in JSON when it's in the tree right now). Use the windows to scope
the real response work: which CI runs installed during the window, which developer
machines pulled during it, which deploys shipped from it — that's your
credential-rotation and forensics scope.

`--history` reads `git log` locally; it never contacts a remote. It needs the lockfile
to be tracked in git.

## Exit codes for your incident bridge

Every `check` invocation is scriptable — fan it out over your repos and let the exit
code sort them:

| Exit | Meaning on incident day |
| --- | --- |
| `0` | Not resolving any queried/bundled version — stand down for this repo |
| `1` | **HIT** — at least one match in the resolved tree; page the owning team |
| `2` | The check didn't run (no lockfile, unparseable lockfile, unknown incident id) — a human must look; **do not** count it as clean |

```bash
#!/usr/bin/env sh
# triage-all.sh — run from a directory containing your repo clones
for repo in */; do
  ( cd "$repo" && npx --yes lockwarden@0.3.1 check --incident node-ipc-may26 --ci )
  case $? in
    0) echo "OK    $repo" ;;
    1) echo "HIT   $repo  <-- respond" ;;
    2) echo "ERROR $repo  <-- inspect manually" ;;
  esac
done
```

For structured fan-out (dashboards, ticket automation), use
[`--json`](/reference/json-output/#lockwarden-check---json) — hits, matches, and full
path arrays in a stable schema.

## Post-incident: pin, verify, scan

Once hit repos are identified:

1. **Fix the resolution.** Pin/override the compromised package away (npm `overrides`,
   yarn `resolutions`, pnpm `pnpm.overrides`), or bump the direct deps that pull it in —
   the path traces from Step 1 tell you which.
2. **Re-run the check.** `npx lockwarden check --incident <id>` must now exit `0` in
   every repo.
3. **Check for tampering that rode along.** Compare the fixed lockfile against the
   pre-incident state:
   ```bash
   npx lockwarden drift --base <pre-incident-ref>
   ```
   [`drift`](/commands/drift/) flags integrity-hash swaps on unchanged versions,
   resolved-URL host moves, and new packages that arrived under patch/minor bumps.
4. **Scan what you shipped.** If a build went out during an exposure window, audit the
   artifact itself — pre-baked `node_modules` tampering never shows up in any manifest:
   ```bash
   npx lockwarden scan ./release-artifacts/app-1.4.2.tgz
   npx lockwarden scan --image registry.internal/app:1.4.2
   ```
   File-level IOCs from incident bundles (sha256 of known payload files) are matched by
   [`scan`](/commands/scan/) too — a hit is Critical.
5. **Rotate what the window touched.** lockwarden tells you *whether and when* you were
   exposed; credential rotation and host forensics for the exposed window are on you —
   it is a [project-scoped auditor, not an EDR](/project/comparison/).

## See also

- [`check` reference](/commands/check/) — every flag, more captured output.
- [Incident bundles](/incidents/) — bundle schema, authoring, validation.
- [Dependency review](/guides/dependency-review/) — the daily habit that shrinks the
  next incident's blast radius.
