# Threat model

lockwarden defends against a specific class of attack: **code that runs when you
install or build a dependency tree, before a single line of your own application
executes.** The attacker's goal is code execution on a developer machine or CI
runner; the package contents are just the delivery vehicle.

This document explains the execution vectors lockwarden looks for and why the
design is shaped the way it is. For how findings are scored, see
[SCORING.md](SCORING.md). For internal design, see [ARCHITECTURE.md](ARCHITECTURE.md).

## The execution vectors

In roughly the order the ecosystem's attacks evolved through 2025–26:

1. **Lifecycle scripts** — `preinstall` / `install` / `postinstall` / `prepare`
   in `package.json`. npm runs them automatically at install time. The classic
   vector, now widely watched.
2. **AI-agent hooks** — config files shipped *inside* packages that AI coding
   agents (Claude, Cursor, Copilot) execute on session start, plus MCP server
   manifests. Malware also harvests AI-tool credentials from these locations.
3. **IDE task files** — `.vscode/tasks.json` and folder-open tasks that fire when
   a developer merely *opens* the project, no install required.
4. **Native build hooks** — `binding.gyp` / node-gyp, which execute at install
   time **even when lifecycle scripts are disabled** (`ignore-scripts=true`).
5. **Pre-baked tampering** — malicious code shipped already vendored inside a
   package's `node_modules`, invisible to any registry- or manifest-level scanner
   because it never appears in a published manifest.

Traditional tooling (`npm audit`, CVE scanners) answers *"does this package have a
reported vulnerability?"* That model fails twice: it misses malicious-by-design
packages until someone reports them, and it never looks at execution surface at
all.

## Why delta over absolute

Legitimate native packages carry `binding.gyp` forever. Legitimate build tools run
`postinstall` forever. Flagging their mere *existence* produces noise that sends a
security tool straight to the uninstall pile.

Attacks **introduce** execution surface in a single version: a new `postinstall`, a
newly-added `binding.gyp`, a 25× jump in the main file's size, a new transitive
dependency arriving under a patch bump. lockwarden weights *what changed between
versions* far above what merely exists — this is both lower-noise and a closer
match to how real 2026 attacks looked. Absolute signals still fire (at low
severity) so a first-time scan isn't blind; delta signals carry the weight.

## What 2026 proved

Each major incident maps to a concrete detection capability:

| Incident | What happened | Capability it exercises |
|---|---|---|
| **Axios / plain-crypto-js (Mar 2026)** | A phantom transitive dep ran a `postinstall` payload, then replaced its own files with clean decoys. Visible only in the lockfile, never in `package.json`. One variant shipped pre-baked in vendored `node_modules`. | Lockfile-first resolution; phantom-dep detection; `scan` of vendored `node_modules` |
| **node-ipc (May 2026)** | Payload delivered via a `binding.gyp` node-gyp hook at install time; CI credentials harvested. Published across multiple major version lines at once to maximize semver-range blast radius. | `binding.gyp` detection; `check` resolving *all* transitive lockfile matches |
| **Shai-Hulud / worm waves (2025–26)** | A worm family evolving from lifecycle scripts → AI-agent session hooks + IDE folder-open tasks → node-gyp. Moved faster than known-bad databases could update. | The full execution-surface analysis; structural detection over feeds |
| **Miasma / namespace compromise (Jun 2026)** | An attacker triggered the victim's own CI to publish trojanized packages **with valid provenance**. A ~200 KB `index.js` became a 4.29 MB obfuscated payload — a 25× size jump. | Provenance treated as informational; size-delta + obfuscation signals |
| **CI-targeting malware (2026)** | Malware identifies hosted-agent security containers, terminates them, and poisons `/etc/hosts` to block their telemetry domains. | The local-first design — there is no backend endpoint to attack or block |

## Design consequences

These vectors dictate the non-negotiable design rules:

- **The lockfile is the source of truth.** Semver ranges mean `package.json`
  doesn't tell you what you actually resolved; 2026 attacks lived in transitive,
  lockfile-only resolutions. All resolution comes from `package-lock.json`,
  `yarn.lock`, `pnpm-lock.yaml`, or `bun.lock`.
- **Structural detection is primary; feeds are secondary.** Execution-surface and
  version-delta analysis works on day zero with zero network, before any advisory
  exists. Known-bad matching (OSV, incident bundles) is an overlay.
- **Provenance is informational, never a pass signal.** Miasma shipped valid
  provenance from a compromised pipeline.
- **Local-first, zero telemetry.** The trust model is now a demonstrated security
  property: malware actively attacks tools that phone home. lockwarden has no
  endpoint to attack, and never uploads your dependency graph anywhere.
- **Detection, not enforcement.** lockwarden never blocks installs or proxies the
  registry — that would mean running infrastructure and betraying the
  zero-backend model.

## Scope and non-goals

lockwarden is a **project-scoped lockfile and artifact auditor**. It is deliberately
not:

- a device/endpoint scanner (it audits a project's dependency tree, not your machine);
- a registry proxy or install blocker (it detects and reports; it never enforces);
- a hosted platform (no accounts, no dashboard, no backend — ever);
- a provenance *verifier* used as a trust gate (provenance is informational only);
- a runtime/EDR behavioral monitor.

npm only, for v1. Advisory data ships vendored in the package and updates via npm
releases — the release cadence *is* the data pipeline. There is no runtime API for
malware to block or for users to distrust.
