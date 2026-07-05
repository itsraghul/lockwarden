# lockwarden — The Complete Owner's Guide (A → Z)

> A single document explaining the whole project in plain language: the problem,
> the idea, every feature with examples, how it works inside, how it's different,
> and how all the infrastructure fits together. Written for the maintainer;
> nothing here is secret, but it's more conversational than the public docs.

---

## 1. The problem in one story

Imagine you run `npm install` on a normal Tuesday. One of your 800 transitive
dependencies — something three levels deep that you've never heard of — shipped a
new version last night. Inside it is a `postinstall` script. npm runs that script
**automatically, during install, with your full user permissions**, before a
single line of your own application ever executes.

That script steals the npm token, AWS keys, and SSH keys from your laptop or CI
runner. By the time anyone notices, it has already published more infected
packages using stolen tokens. This is not hypothetical — it's the standard shape
of every major npm supply-chain attack.

And the attacks have evolved past `postinstall`:

| Vector | How it executes | Why it's sneaky |
|---|---|---|
| **Lifecycle scripts** (`preinstall`/`install`/`postinstall`) | npm runs them at install time | The classic; widely watched now |
| **`binding.gyp` / node-gyp** | Building a "native module" runs arbitrary commands at install | Runs **even when you set `ignore-scripts=true`** |
| **Prebuilt `.node` binaries** | Native machine code loads the moment the package is `require()`d | No script, no gyp file — nothing to see at install at all |
| **AI-agent hooks / MCP manifests** | Config files inside packages that Claude/Cursor/Copilot execute on session start | Brand-new vector; also harvests AI-tool credentials |
| **IDE task files** (`.vscode/tasks.json` with `runOn: folderOpen`) | Executes when a developer merely **opens the folder** | You never even installed anything |
| **Pre-baked `node_modules`** | Malicious code shipped already vendored inside another package's `node_modules` | Never appears in any manifest, invisible to registry scanners |

The tooling most teams have (`npm audit`, CVE scanners) answers a different
question: *"does this package have a **reported** vulnerability?"* That fails
twice against these attacks: malicious-by-design packages have no CVE until
someone reports them (hours or days later), and those tools never look at what a
package can *execute* anyway.

## 2. The idea in one sentence

**Everyone else asks "is this package known-bad?" — lockwarden asks "what can
this dependency tree execute, and what changed?"**

Two beliefs drive everything:

1. **Execution surface is measurable structure, not reputation.** You don't need
   a database of villains to notice a package gained a `postinstall` script, a
   `binding.gyp`, an MCP manifest, or a 25× bigger main file. Structure is
   visible on day zero, before any advisory exists.

2. **Change is the signal, existence is noise.** Thousands of legitimate packages
   have carried install scripts for a decade (esbuild, sharp, core-js…). Flagging
   them forever = noise = uninstall. But a package that *introduces* execution
   surface in one version bump — that's exactly what every real attack looks
   like. So lockwarden weights *deltas* (newly appeared surface) far above
   *absolutes* (surface that exists).

## 3. What it concretely is

A **free, MIT-licensed CLI** published on npm. You run it with `npx lockwarden …`
— no install, no account, no configuration. It reads your **lockfile** (the file
that records what you *actually* resolved — `package-lock.json`,
`yarn.lock`, or `pnpm-lock.yaml`), analyzes packages, and exits with a code your
CI can act on.

**Exit codes are the API:**
- `0` — clean (or findings below your threshold)
- `1` — findings at/above threshold ("fail the build")
- `2` — couldn't run (bad lockfile, offline violation, bad args)

Why lockfile and not `package.json`? Because `package.json` says `"axios": "^1.6.0"`
— a *range*. The lockfile says which exact version of axios **and of its 40
transitive dependencies** you really got. The 2026 attacks lived precisely in
that transitive, lockfile-only space.

## 4. The five commands (with real examples)

### 4.1 `check` — "Am I hit?" (incident triage)

The one you paste into Slack during an incident.

```
$ npx lockwarden check node-ipc@9.1.6

lockfile: package-lock.json (npm)
  HIT  node-ipc@9.1.6
       project → @vue/cli-shared-utils@4.5.19 → node-ipc@9.1.6
exit 1
```

It shows **every path** by which the package enters your tree (there can be
many), labels dev-only paths, and accepts exact versions, semver ranges, or bare
names.

- `check --incident node-ipc-may26` — checks a whole **incident bundle** at once:
  a curated list of compromised packages+versions that ships *inside* lockwarden
  and updates via npm patch releases within hours of a real incident.
- `check axios --history` — walks the **git history of your lockfile** and
  answers "were we *ever* exposed, and during which commits?" — for free, from
  local git. (Competitors sell this as an enterprise feature.)

### 4.2 `audit` — the execution-surface report card

```
$ npx lockwarden audit
grade C — 31 packages flagged of 320 analyzed
med 32 · low 1
```

Walks every installed package in `node_modules` (it understands npm's flat
layout, pnpm's store layout, and nested trees), runs all nine analyzers, and
grades each package **A–F** plus a project rollup.

The killer mode is **`audit --diff main`** — the PR gate. When Renovate bumps a
dependency, this compares against the lockfile at the base ref, downloads the
*previous* version of only the changed packages, and reports what the bump
**introduced**:

```
grade F — lodash@4.17.22
  CRITICAL  LW001D-LIFECYCLE-INTRODUCED  postinstall appeared in this version
```

That's the signal that would have caught node-ipc, plain-crypto-js, and the worm
waves on day zero — no advisory needed. `--deep` does the same for the whole
tree (slow, for scheduled runs).

### 4.3 `drift` — "did my lockfile change in ways my manifest doesn't explain?"

Lockfiles get tampered with directly (a malicious commit, a compromised bot).
`drift --base main` compares and flags:

- **Integrity swap** (Critical): same `left-pad@1.3.0`, different content hash.
  There is no honest reason for this.
- **Resolved-URL move**: the tarball now downloads from a different host.
- **Unexplained version change**: resolved version changed but no `package.json`
  edit explains it.
- **Patch-smuggled dependency**: a patch bump of an existing dep quietly brought
  a brand-new transitive package with it (the axios/plain-crypto-js trick).

### 4.4 `scan` — "what's actually inside the thing I ship?"

Registry scanners see what was *published*. `scan` analyzes what's *on disk*:

```
lockwarden scan build-output.tgz         # tarball, zip, or directory
lockwarden scan --image myapp:latest     # docker image layers (via docker save)
```

It finds every embedded `node_modules` package inside the artifact (handling
Docker layer ordering and whiteout files correctly) and runs the same analyzers
plus known-bad matching — catching malicious code pre-baked into vendored
dependencies that never appeared in any manifest. Also matches file-level IOCs
(sha256 hashes) from incident bundles.

### 4.5 `secrets` — minimal credential scan

Deliberately small, never the headline: ~15 curated regexes (AWS keys, GitHub
PATs, npm tokens, private-key headers…) + an entropy check, over your source and
over dependency install-path files. Found secrets are always masked in output.

### Global flags (all commands)

`--json` (stable machine output) · `--sarif` (GitHub Security tab format) ·
`--ci` (no color, counts only) · `--dir` (monorepo roots) · `--threshold <sev>`
(what triggers exit 1; default `high`) · `--offline` (**hard-fail** exit 2 if
anything tries the network — lets paranoid/airgapped CI *prove* the local-first
claim).

## 5. How scoring works (the two layers)

### Layer 1 — structural (works with zero network, zero feeds)

Nine analyzers each emit **facts** ("this package has X"), never severities. A
separate scoring engine maps each fact to a weight:

| Signal | Exists (absolute) | Newly appeared (delta) |
|---|---|---|
| Lifecycle install script | Med | **Critical** |
| `binding.gyp` / node-gyp hook | Low | **Critical** |
| AI-agent hook / MCP manifest | Med | **Critical** |
| IDE task / folder-open file | Med | High |
| Main-file size >5× vs previous | — | High |
| New transitive dep in a patch release | — | **Critical** |
| Obfuscation markers (hex arrays, eval chains, packed lines) | Med | High |
| Phantom dependency (declared, never imported) | Med | — |
| Prebuilt `.node` binary / prebuild fetcher | Low | **Critical** |

Read one row aloud and the philosophy is obvious: *having* a binding.gyp is a
Low (native packages are normal); *gaining* one is Critical (that's an attack).

A few compound shapes get elevated because they match validated attack patterns:
size-inflation **and** new obfuscation in the same version (the node-ipc shape),
an IDE task that auto-runs on folder open. Grades: any Critical → **F**;
otherwise severity sum maps to A–F; project rollup = worst grade + counts.

### Layer 2 — known-bad overlay

Every resolved `name@version` is matched against a **vendored** OSV
malware-advisory snapshot and the incident bundles. Any hit = Critical = F,
regardless of Layer 1. "Vendored" means the data ships inside the npm package
itself — there is no lookup API. **The npm release cadence is the data
pipeline.**

### Why the weights are trustworthy: the corpus

`corpus/` (in the repo, never shipped) is the calibration harness — arguably the
most important engineering decision in the project. Analyzers are **written
there first**, run against ~60 (target 500) real top-download packages *and* a
set of synthetic malicious fixtures (a benign package with a mutation applied:
injected postinstall, added binding.gyp, inflated main file, planted `.node`
binary…). Weights ship only when the **separation gate** passes: every malicious
fixture grades F in delta mode, while benign version-bumps produce **zero**
Criticals. `src/scoring/weights.ts` is machine-transcribed from that run — the
header names the corpus commit, and hand-editing is forbidden. That's how a
detection tool stays low-noise instead of becoming alarm spam.

## 6. How it works internally (the pipeline)

```
lockfile ──▶ resolution graph ──▶ analyzers ──▶ signals ──▶ scoring ──▶ report
```

1. **Parsers** (`src/lockfile/`) — npm v1/v2/v3, yarn classic (custom-written
   parser), yarn berry, pnpm 6/9 all normalize into one `ResolutionGraph`:
   packages keyed `name@version`, explicit dependency edges, and a reverse index.
   Every downstream feature is lockfile-format-agnostic because of this.
   `check`'s path traces are a cycle-safe reverse depth-first search over that
   reverse index (capped at 500 paths).

2. **Artifact loading** (`src/lib/`) — a custom tar.gz reader (raw 512-byte
   header parsing, PAX/longname support, path-traversal rejection), a custom zip
   reader, a docker-save layer walker, and a directory walker all produce the
   same `PackageArtifact` shape: a file map with lazy reads.

3. **Analyzers** (`src/analyzers/`) — nine small modules against one contract:
   take an artifact (plus optionally the previous version and tree context),
   return `Signal[]` with evidence and raw metrics. No severities. No I/O
   beyond the artifact. This keeps them corpus-testable in isolation.

4. **Scoring** (`src/scoring/`) — weights → severities → elevations → Layer-2
   overlay → grades → rollup → threshold → exit code. SARIF output has stable
   fingerprints so GitHub's Security tab tracks findings across runs.

5. **The network chokepoint** (`src/lib/net.ts`) — the **only file in the
   codebase allowed to reference `fetch`**, enforced by a unit test that greps
   the source tree. `--offline` flips a flag that makes this module throw before
   any dispatch. Tarball downloads (the only network use, for `--diff`/`--deep`)
   are SRI-verified against the lockfile hash and cached in `~/.lockwarden/cache`.

**Dependency budget:** the shipped CLI has exactly **3 runtime dependencies**
(commander, yaml, semver — each with zero transitive deps) against a hard cap of
<10 total transitive. Tar/zip parsing, SARIF, SRI, colors — all custom instead of
dependencies. A supply-chain security tool with a 200-package tree would be a
joke; ours is auditable in one glance, and CI runs `lockwarden audit` **on
lockwarden itself** every commit.

## 7. How it's different (honest version)

| | lockwarden | Socket | Snyk | npm audit |
|---|---|---|---|---|
| Architecture | Local CLI, zero backend | Hosted platform | Hosted platform | Local, feed-based |
| Account needed | Never | Yes | Yes | No |
| Your dep graph leaves your machine | Never | Yes | Yes | No |
| Detection | Structure + deltas (day-zero) | Server-side behavioral analysis | CVE database | Advisory database |
| binding.gyp / AI-agent hooks / IDE tasks / prebuilt binaries | Yes | Partial | No | No |
| Vendored node_modules & docker layers | Yes | No | Containers = CVE-only | No |
| "Was I ever exposed?" history | Free, from git | — | — | No |

The honest part (this discipline is a project rule): **Socket's server-side
behavioral analysis is deeper than any local heuristic can be.** lockwarden does
not compete on analysis depth. It wins on: the trust model (nothing leaves your
machine — and 2026 malware literally kills and blocks security agents that phone
home; lockwarden has no endpoint to attack), coverage of the newest vectors,
artifact scanning, and zero-friction incident triage. Teams can and do run both.
Also deliberately **not**: an install blocker, a registry proxy, a device
scanner, or a runtime monitor — it's a project-scoped auditor that detects and
reports.

## 8. The supporting machinery

- **GitHub Action** (`packages/action`) — two lines of YAML in a consumer's repo
  = `audit --diff` on every lockfile-touching PR, with SARIF uploaded to their
  Security tab. Pins an exact CLI version (`@v1` is a moving git tag).
- **Incident pipeline** (`.github/workflows/incident-bundle.yml`) — one workflow
  dispatch with an IOC JSON goes: schema validation → self-test (a generated
  lockfile containing a listed package must exit 1, a clean one must exit 0) →
  **npm patch published first** (the world can run `check --incident` within
  minutes) → the version commit lands via auto-merged PR. Target: under 15
  minutes from IOC to a globally available check.
- **Releases** — changesets + GitHub Actions + **npm Trusted Publishing
  (OIDC)**: no tokens anywhere, every release carries a SLSA provenance
  attestation. A publish-hygiene CI gate diffs the tarball file list against a
  committed allowlist (nothing unexplained ever ships).
- **CI** — lint (biome), strict tsc, 270+ tests (fully offline, real fixture
  tarballs, exit-code matrices, an `--offline` proof), Node 22/24 matrix plus a
  pnpm-free Node 20.12 smoke job proving the engine floor, and the self-audit.
  `main` is protected: everything lands via PR + green CI.
- **Site** (`site/` → [lockwarden.dev](https://lockwarden.dev)) — 21-page Astro
  Starlight docs: guides (CI recipes for every major CI, incident runbook),
  full command reference with real captured output, comparison page, 11
  architecture-decision records, and `llms.txt` / `llms-full.txt` so AI agents
  can ingest the entire docs in one fetch. Zero external resources — the site is
  as local-first as the tool.
- **Project memory** — `MEMORY.md` (durable decisions: naming/registry facts,
  toolchain gotchas, calibration decisions) and `JOURNAL.md` (release-notes
  timeline of every session), both wired into CLAUDE.md so any future session —
  human or AI — picks up full context.

## 9. Where the project stands & what's in flight

- **Published:** `lockwarden@0.3.1` on npm (with provenance), all five commands
  live, Action tagged `@v1`, site live on lockwarden.dev.
- **Open PRs:**
  - **#7 — audit baseline**: a checked-in `.lockwarden-baseline.json` of
    reviewed findings so CI at stricter thresholds fails only on **new**
    surface. Critically: Layer-2 hits, Criticals, and F-grade deltas can never
    be suppressed, and suppressed findings stay visible everywhere. This is the
    feature that makes `audit` adoptable on a big existing codebase.
  - **#8 — native-binary analyzer (LW009)**: the ninth analyzer described above
    (prebuilt `.node` binaries + prebuild-fetcher toolchains), corpus-calibrated
    with zero benign noise. Closes the quietest execution vector.
  - They conflict only on MEMORY/JOURNAL entries (both prepend); merge one, then
    update the other keeping both entries.
- **Known future work:** grow the benign corpus 60 → 500 before declaring
  weights final; keep incident bundles flowing when real incidents hit; the
  `--deep` precomputed index and other ecosystems (PyPI) are explicitly
  post-v1 ideas, not commitments.

## 10. The mental model to keep

lockwarden is a **burglar-alarm engineer for your dependency tree**. It doesn't
ask whether any resident has a criminal record (that's the databases — useful,
but always late). It walks the building and reports: *these are the doors, these
are the windows, these ones can open themselves* — and, most importantly —
***that window wasn't there yesterday.***

Everything else in the repo — the corpus gate, the 3-dependency budget, the
offline chokepoint, the vendored data, the provenance-signed releases — exists to
make one claim credible: **the security tool itself is exactly as trustworthy,
minimal, and inspectable as it demands your dependencies be.**
