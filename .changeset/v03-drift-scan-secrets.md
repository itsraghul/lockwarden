---
'lockwarden': minor
---

v0.3 — `drift`, `scan`, and `secrets` complete the v1 command surface.

- `lockwarden drift [--base <ref>]` — lockfile tampering detection: integrity
  swaps on unchanged versions (Critical), resolved-URL host moves, version
  changes unexplained by package.json, new packages arriving via patch/minor
  bumps. Provenance is reported as informational only — never a pass signal.
- `lockwarden scan <artifact> | --image <docker-image>` — execution-surface +
  known-bad analysis of what is ACTUALLY on disk: vendored node_modules inside
  tarballs, zips, directories, and docker-save layers (later-layer-wins,
  whiteouts honored). Catches pre-baked tampering no registry scanner sees.
  Incident-bundle fileIocs sha256 matching included. Fully offline.
- `lockwarden secrets [--dir <path>]` — minimal credential scan (15 curated
  patterns + entropy) over project source and dependency install-path files.
  Secrets are always masked in every output mode.
- Incident-day automation: one workflow dispatch takes an IOC bundle JSON
  through validation, self-test, npm patch publish, and an auto-merged PR.
