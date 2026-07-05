# Contributing

Thanks for looking at lockwarden. It's a small, focused tool with a few firm rules
— reading [ARCHITECTURE.md](ARCHITECTURE.md) first will save you time.

## Development setup

```bash
git clone https://github.com/itsraghul/lockwarden.git
cd lockwarden
pnpm install            # Node 22+ for development (pnpm 11 requires it)
pnpm build              # tsup → packages/cli/dist/index.js
pnpm test               # vitest: unit + integration, fully offline
pnpm lint && pnpm typecheck
```

The published CLI itself runs on **Node 20.12+**; a CI smoke job verifies the built
artifact against that floor. Only the dev toolchain needs Node 22.

Run the built CLI directly:

```bash
node packages/cli/dist/index.js audit
```

## Ground rules

These are non-negotiable — a PR that violates one won't merge:

1. **Local-first, zero telemetry.** No analytics, no phone-home, no backend. Ever.
2. **Network only for tarball fetches** during `--diff` / `--deep`, and only through
   `src/lib/net.ts`. `--offline` must hard-fail (exit 2) on any attempt.
3. **Lockfile is the source of truth** — never resolve from `package.json` alone.
4. **Dependency budget: fewer than 10 total transitive runtime deps.** Adding a
   runtime dependency needs a strong justification; prefer a small custom
   implementation. (Dev dependencies are unconstrained.)
5. **Exit codes are the API:** `0` clean, `1` findings at/above threshold, `2`
   error. Every command stays CI-composable.
6. **`--json` and `--sarif` outputs are stable** and snapshot-tested.

## Working on analyzers

Analyzers are **born in `corpus/` and promoted into `src/analyzers/`** — not written
directly in `src`. This is because weights are meaningless until validated against
the calibration corpus. The workflow:

1. Write/adjust the analyzer in `corpus/src/analyzers/`.
2. `pnpm corpus:fetch` (once) and `pnpm corpus:run` to regenerate the separation
   report and `weights.json`. The gate: every malicious fixture grades F in delta
   mode, benign version-bumps produce zero Criticals.
3. Promote the analyzer file into `src/analyzers/` and transcribe the new weights
   into `src/scoring/weights.ts` (keep the source-commit header accurate).
4. Add fixtures and unit tests.

## Adding an incident bundle

1. Add a JSON file under `packages/cli/src/data/incidents/` matching `_schema.json`.
2. `node --experimental-strip-types scripts/generate-incident-index.ts` to
   regenerate the index.
3. `node --experimental-strip-types scripts/validate-incident-bundle.ts <file>`
   self-tests it (a lockfile containing a listed package must exit 1; a clean one
   must exit 0).

Maintainers can also ship a bundle through the `incident-bundle` workflow, which
runs the same gate and publishes a patch release.

## Tests

- **Everything runs offline.** A network attempt in a test throws.
- Unit tests per parser/analyzer/scoring module; integration tests spawn the built
  CLI against fixture projects and assert the exit-code matrix.
- Secret-like strings in test fixtures are constructed at runtime, never committed
  as literals — a security tool must not carry a real-looking credential (and push
  protection will reject it).

## Pull requests

`main` is protected: changes land via a branch → PR → green CI (lint, typecheck,
tests on Node 22/24, the Node 20 smoke job, and a self-audit of lockwarden's own
tree). Releases are handled by [changesets](https://github.com/changesets/changesets)
— run `pnpm changeset` and describe your change; a maintainer merges the version PR
to publish.

By contributing you agree your work is licensed under the project's [MIT
license](../LICENSE).
