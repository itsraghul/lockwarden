---
'lockwarden': minor
---

New `lockwarden explain [code]` command: what a finding code detects, why it carries its weights, and what to do when it fires — fully offline, always exit 0 (2 for an unknown code). Accepts family ids (`LW001`), full absolute/delta codes, analyzer ids (`lifecycle-scripts`), and Layer-2 codes; a full dynamic code like `LW2-IOC-<incident-id>` also resolves the vendored advisory it points at. Severities are read live from the corpus-locked weights table so `explain` can never disagree with what `audit` scores. Stable `--json` shape documented in the JSON output reference.
