---
title: Scoring
description: The two-layer scoring model — structural execution-surface signals with absolute and delta weights, grades A–F, the known-bad overlay, and SARIF mapping.
---

lockwarden scores in two layers. **Layer 1 is structural** — it analyses execution surface
and version deltas, works on day zero with zero network and zero advisory data, and is
the primary detection. **Layer 2 is a known-bad overlay** — feed-based matching that can
only ever confirm what someone already reported.

## Layer 1 — execution-surface signals

Each signal carries two weights: an **absolute** weight (the signal exists in the tree)
and a **delta** weight (the signal *newly appeared* in this version). Delta weights
dominate by design: legitimate native packages carry `binding.gyp` forever, but attacks
*introduce* it — a new hook in a version bump is the 2026 attack signature.

| Signal | Absolute weight | Delta weight (newly appeared this version) |
| --- | --- | --- |
| Lifecycle install script | Low–Med | **Critical** |
| `binding.gyp` / node-gyp hook | Low | **Critical** |
| AI-agent hook / MCP manifest | Med | **Critical** |
| IDE task / folder-open file | Med | **High** |
| Main-file size anomaly (>5x) | — | **High** |
| New transitive dep in a patch release | — | **High** |
| Obfuscation markers in install-path files | Med | **High** |
| Phantom dependency | Med | — |

Delta weights apply only in `--diff` / `--deep` modes (which fetch previous tarballs for
comparison); absolute weights always apply.

## Grades A–F

- Each package receives a grade **A–F** from its combined signals.
- The project rollup is the **worst grade** in the tree plus a count summary per grade.
- `--threshold <grade>` (default: `high`) sets the severity at which findings flip the
  exit code to `1` — grades below the threshold are reported but don't fail the run.

## Layer 2 — known-bad overlay

- **Sources:** a vendored OSV.dev npm snapshot, npm advisory data, and vendored
  [incident IOC bundles](/incidents/) — all shipped inside the npm package and refreshed
  each release. No feed is fetched at runtime.
- **Matching:** resolved `name@version` from the lockfile.
- **Any Layer-2 hit is Critical**, regardless of the package's Layer-1 score.

Layer 2 exists because confirming a *known* incident should be instant and unambiguous.
It is deliberately secondary: the 2026 worm waves outran every known-bad database, which
is exactly why Layer 1 doesn't depend on one.

## SARIF mapping

| Grade | SARIF level |
| --- | --- |
| Critical | `error` |
| High | `warning` |
| Med | `note` |
| Low | suppressed by default (`--verbose` to include) |

SARIF 2.1.0 output (`--sarif`) uploads directly to the GitHub Security tab — the
[GitHub Action](/github-action/) wires this up automatically.

## Calibration: weights are gated on a corpus

All Layer-1 weights are **provisional until corpus calibration shows clean separation**
between the top ~500 benign npm packages and the confirmed 2026 malicious set (the Axios
`plain-crypto-js` phantom dep, the node-ipc versions, the autotel family, and the Miasma
`@redhat-cloud-services` versions). A security tool that flags every legitimate native
package trains its users to ignore it — noise is a bug of the same severity as a miss,
and the calibration harness is the gate that keeps thresholds honest before they ship.
