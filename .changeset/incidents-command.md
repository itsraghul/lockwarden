---
'lockwarden': minor
---

New `lockwarden incidents` command: list every incident IOC bundle this build knows — the valid ids for `check --incident <id>` — newest first, with dates, package counts, file-IOC counts, and an OSV-snapshot summary line. Purely informational (always exit 0; exit 2 only on execution errors). `LOCKWARDEN_INCIDENT_DIR` overlays are marked `[local overlay]` / `"local": true`. Stable `--json` shape documented in the JSON output reference. The `check --incident` unknown-id hint now points at it.
