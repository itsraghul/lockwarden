---
title: Scoring
description: The two-layer scoring model — structural signals with absolute and delta weights, grades A–F, compound elevations, the known-bad overlay, SARIF mapping, and corpus calibration.
---

lockwarden scores in two layers. **Layer 1 is structural** — it analyses execution
surface and version deltas, works on day zero with zero network and zero advisory data,
and is the primary detection. **Layer 2 is a known-bad overlay** — feed-based matching
that can only ever confirm what someone already reported.

## Layer 1 — execution-surface signals

Analyzers emit **facts** (signals), never severities. The scoring engine maps each
`(analyzer, kind)` pair to a weight, where `kind` is `absolute` (the surface exists) or
`delta` (the surface *newly appeared* in this version vs the previous one). Delta weights
dominate by design: legitimate native packages carry `binding.gyp` forever, but attacks
*introduce* it — a new hook in a version bump is the 2026 attack signature.

| Signal (analyzer) | Rule codes | Absolute | Delta (newly appeared) |
| --- | --- | --- | --- |
| Lifecycle install script (`lifecycle-scripts`) | `LW001`, `LW001D` | Med | **Critical** |
| `binding.gyp` / node-gyp hook (`binding-gyp`) | `LW002`, `LW002D` | Low | **Critical** |
| AI-agent hook / MCP manifest (`agent-hooks`) | `LW003`, `LW003D` | Med | **Critical** |
| IDE task / folder-open file (`ide-tasks`) | `LW004`, `LW004D` | Med | **High** |
| Main-file size anomaly, >5× vs previous (`size-delta`) | `LW005D` | — | **High** |
| New transitive dep in a patch release (`dep-introduction`) | `LW006D` | — | **Critical** |
| Obfuscation markers in install-path files (`obfuscation`) | `LW007`, `LW007D` | Med | **High** |
| Phantom dependency — declared, never imported (`phantom-deps`) | `LW008` | Med | — |
| Prebuilt native binary — `.node` file / prebuild fetcher (`native-binary`) | `LW009`, `LW009D` | Low | **Critical** |

Delta weights apply only in [`--diff` / `--deep` modes](/commands/audit/#modes) (which
fetch previous tarballs for comparison); absolute weights always apply, so a first-time
scan isn't blind — it's just deliberately quieter. A “—” weight means the signal carries
no severity in that mode (a package's *absolute* main-file size proves nothing; only the
jump does).

What the analyzers actually look at, in brief: lifecycle scripts are
`preinstall`/`install`/`postinstall`/`prepare` in `package.json`; agent-hooks flags MCP
manifest filenames (`mcp.json`, `*.mcp.json`, `mcp-manifest*`), files declaring
`mcpServers`, and hook/SessionStart config under agent directories (`.claude/`,
`.cursor/`, `.github/copilot`) *shipped inside a package*; ide-tasks flags
`.vscode/tasks.json` (and settings) inside a package, with `runOn: folderOpen` treated
specially; obfuscation measures hex-array density, eval chains, and packed lines in
install-path files; native-binary flags shipped `.node` files (native code that loads at
*require*-time — no `binding.gyp`, possibly no lifecycle script) and prebuilt-binary
fetcher toolchains (`prebuild-install`, `node-pre-gyp`, `node-gyp-build`, `prebuildify`)
in runtime deps or scripts. Note the meta-package pattern: sharp/esbuild-style packages
fan out to per-platform `optionalDependencies`, so the *platform* packages
(`@img/sharp-linux-x64`, …) each carry the Low absolute finding while the meta package
stays clean — expected, since the platform packages are what ship the binaries.

## Compound elevations

Two delta shapes are elevated to **Critical** beyond their base weight because they match
validated attack shapes:

- An IDE task delta that **auto-runs on folder open** (`runOn: folderOpen`) — the
  Shai-Hulud shape. Opening the project is the install.
- **Size inflation and new obfuscation in the same version** — the node-ipc/Miasma shape
  (a ~200 KB `index.js` became a 4.29 MB obfuscated payload).

Each elevation was verified against the calibration corpus to add **zero** false
Criticals on benign version bumps.

## Grades A–F

Severity maps to grade directly: Critical→**F**, High→**D**, Med→**C**, Low→**B**,
nothing→**A**. A package's grade is driven by its **worst** finding after elevations —
so any Critical finding means grade F. The project rollup is the worst package grade in
the tree plus a count per severity:

```
grade F — 2 packages flagged of 2 analyzed
critical 2 · med 2
```

`--threshold` (default: `high`) sets the severity at which findings flip the exit code
to `1` — it accepts severity names or the equivalent grade letters (`B`=low, `C`=med,
`D`=high, `F`=critical). Findings below the threshold are reported but don't fail the
run. See [exit codes](/reference/exit-codes/).

### Worked example: why this package gets a D… and that one an F

A version bump of `some-pkg` from 3.1.0 → 3.1.1 shows, in `audit --diff`:

1. `LW005D-SIZE-INTRODUCED` — main file grew 8× → delta weight **High**.
2. No other signals. Worst severity High → **grade D**. At the default `high` threshold,
   exit `1`.

Now suppose the same bump also shows `LW007D-OBFUSCATION-INTRODUCED` (new obfuscation
markers, High). Individually the worst severity is still High — but *size inflation +
new obfuscation in the same version* matches a compound elevation, so the package is
raised to Critical → **grade F**. That's the node-ipc shape, and it's exactly the
combination the corpus validated.

## Layer 2 — known-bad overlay

- **Sources:** a vendored OSV.dev npm-malware snapshot and vendored
  [incident IOC bundles](/incidents/) — all shipped inside the npm package and refreshed
  each release. No feed is fetched at runtime.
- **Matching:** resolved `name@version` from the lockfile (`audit`), or embedded
  packages and file-content sha256 IOCs (`scan`).
- **Any Layer-2 hit is Critical** — grade F — regardless of the package's Layer-1 score.
  Rule codes are `LW2-OSV-<id>`, `LW2-IOC-<id>`, and `LW2-IOC-<id>-FILE`.

Layer 2 exists because confirming a *known* incident should be instant and unambiguous.
It is deliberately secondary: the 2026 worm waves outran every known-bad database, which
is exactly why Layer 1 doesn't depend on one. (Rationale:
[structural detection primary](/project/architecture-decisions/#3-structural-detection-primary-feeds-vendored-and-secondary).)

## SARIF mapping

| Severity | SARIF level |
| --- | --- |
| Critical | `error` |
| High | `warning` |
| Med | `note` |
| Low | suppressed by default (`--verbose` to include) |

SARIF 2.1.0 output (`--sarif`) uploads directly to the GitHub Security tab — the
[GitHub Action](/github-action/) wires this up automatically. Structure details
(rules, logical locations, stable fingerprints):
[JSON output → SARIF](/reference/json-output/#sarif-output---sarif).

## Calibration: weights are gated on a corpus

No weight on this page was chosen by intuition. A calibration harness (`corpus/` in the
repo, never shipped) runs every analyzer against two sets:

- **benign:** top-download npm packages (currently 60; the target is the full top 500),
  including their real version-to-version bumps;
- **malicious:** synthetic, defanged fixtures reproducing each 2026 attack shape — an
  injected `postinstall`, an added `binding.gyp`, an inflated main file, a phantom dep,
  and the compound shapes above.

The gate: **every malicious fixture must grade F in delta mode while benign version
bumps produce zero Criticals.** The shipped weights table is generated from that run
(the source file carries the corpus commit in its header) and is never hand-edited —
analyzers are in fact [born in the corpus and promoted into the CLI](/project/architecture-decisions/#9-corpus-gated-weights--analyzers-are-born-in-corpus).

Weights remain **provisional until the benign set reaches the full top-500**. The
malicious reference set includes the confirmed 2026 incidents: the axios
`plain-crypto-js` phantom dep, the node-ipc versions, the autotel family, and the Miasma
`@redhat-cloud-services` versions. A security tool that flags every legitimate native
package trains its users to ignore it — noise is a bug of the same severity as a miss.

## See also

- [Threat model (repo)](https://github.com/itsraghul/lockwarden/blob/main/docs/THREAT-MODEL.md) —
  the vectors these signals detect and the 2026 incidents behind them.
- [`audit`](/commands/audit/) — the command that produces these scores.
- [Dependency review](/guides/dependency-review/#interpreting-delta-findings) — reading
  findings as a reviewer.
- [JSON output](/reference/json-output/#the-finding-object) — findings as data.
