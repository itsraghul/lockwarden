---
"lockwarden": minor
---

Advisory-data freshness surfacing: `audit` and `scan` reports gain an additive `advisories` object (`osvGeneratedAt`, `newestIncident` — dates only) plus a human-output freshness line; new global `--max-advisory-age <days>` exits 2 when the vendored advisory data is older than the limit (applies to `audit`, `scan`, and `check --incident`; plain `check` and `--history` are exempt — they never read advisory data). The vendored OSV snapshot migrates to a metadata wrapper with a `generatedAt` stamp. Also: `scan` now supports zip64 archives (>65,535 entries — large lambda bundles); per-entry zip64 (≥4GiB entries) remains unsupported with a clear error.
