---
'lockwarden': minor
---

bun.lock support: `check`, `audit`, `drift`, and every lockfile-driven flow now parse Bun's textual lockfile (Bun ≥1.2, JSONC) into the same unified resolution graph as npm/yarn/pnpm — nested version conflicts, scoped packages, dev/optional classification, and integrity all modeled. A lone binary `bun.lockb` gets a clear exit-2 hint to run `bun install --save-text-lockfile`. Zero new dependencies (the JSONC reader is ~60 lines in-repo).
