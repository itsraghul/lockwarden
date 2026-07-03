# lockwarden

> Audit what your npm dependency tree can **execute** — and answer *"am I hit?"* in seconds during supply-chain incidents.

This is the development monorepo. The CLI lives in [packages/cli](packages/cli) (npm: [`lockwarden`](https://www.npmjs.com/package/lockwarden)) — its README is the user-facing front door.

- [v1 specification](docs/lockwarden-v1-spec.md)
- [Use case & learnings](docs/lockwarden-use-case-and-learnings.md)
- `corpus/` — calibration harness (not shipped): analyzers are written here against real tarballs, and every scoring weight is gated by its separation report.

## Development

```bash
pnpm install
pnpm build          # tsup → packages/cli/dist/index.js (single file)
pnpm test           # vitest: unit + integration (fully offline)
pnpm lint && pnpm typecheck
```

Corpus calibration (dev-only; the one place network fetches are routine):

```bash
pnpm corpus:fetch -- --limit 60   # benign tarballs → corpus/cache/
pnpm corpus:build                 # synthetic defanged malicious fixtures
pnpm corpus:run                   # → corpus/report/separation-report.md
```
