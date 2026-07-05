---
title: Contributing
description: How to contribute to lockwarden — the ground rules, the corpus-first analyzer workflow, and where the full contributor docs live.
---

lockwarden is a small, focused tool with a few firm rules. The full contributor
documentation lives in the repository:

- [CONTRIBUTING.md](https://github.com/itsraghul/lockwarden/blob/main/docs/CONTRIBUTING.md) —
  setup, workflows, PR process.
- [ARCHITECTURE.md](https://github.com/itsraghul/lockwarden/blob/main/docs/ARCHITECTURE.md) —
  the pipeline, the resolution model, the analyzer contract.
- [THREAT-MODEL.md](https://github.com/itsraghul/lockwarden/blob/main/docs/THREAT-MODEL.md) —
  what lockwarden defends against and why the design follows.

## Quick start

```bash
git clone https://github.com/itsraghul/lockwarden.git
cd lockwarden
pnpm install            # Node 22+ for development (pnpm 11 requires it)
pnpm build              # tsup → packages/cli/dist/index.js
pnpm test               # vitest: unit + integration, fully offline
```

The published CLI itself runs on **Node 20.12+**; a CI smoke job verifies the built
artifact against that floor. Only the dev toolchain needs Node 22.

## The ground rules

These are non-negotiable — a PR that violates one won't merge. Each traces to an
[architecture decision](/project/architecture-decisions/):

1. **Local-first, zero telemetry.** No analytics, no phone-home, no backend. Ever.
2. **Network only for tarball fetches** during `--diff`/`--deep`, and only through the
   [chokepoint module](/trust-model/#the-single-chokepoint). `--offline` must hard-fail
   (exit `2`) on any attempt.
3. **Lockfile is the source of truth** — never resolve from `package.json` alone.
4. **Dependency budget:** fewer than 10 total transitive runtime deps (currently 3).
   Prefer a small custom implementation over a new dependency.
5. **Exit codes are the API** — `0`/`1`/`2`, every command
   [CI-composable](/reference/exit-codes/).
6. **`--json` and `--sarif` outputs are stable** and snapshot-tested — additive changes
   only.

Two workflow rules worth knowing before you start:

- **Analyzers are born in `corpus/`**, calibrated against the benign/malicious corpus,
  and only then promoted into `src/analyzers/` — weights are
  [generated, never hand-edited](/scoring/#calibration-weights-are-gated-on-a-corpus).
- **Tests run fully offline.** A network attempt in a test throws. Secret-like strings
  in fixtures are constructed at runtime, never committed as literals.

## Adding an incident bundle

The fastest way to contribute during an incident: author a bundle matching the
[schema](/incidents/#bundle-schema), self-test it (hit tree exits `1`, clean tree exits
`0`), and open a PR — or file an issue with the IOC data. Maintainers can ship a
validated bundle to npm within hours through the automated release workflow.

## License

MIT. By contributing you agree your work is licensed under the project's
[LICENSE](https://github.com/itsraghul/lockwarden/blob/main/LICENSE).
