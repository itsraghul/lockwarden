# lockwarden

> Audit what your npm dependency tree can **execute** — and answer *"am I hit?"* in seconds during supply-chain incidents.

Everyone else asks "is this package known-bad?" — lockwarden asks **"what can this tree execute, and what changed?"**

- **Local-first.** Zero telemetry, zero accounts, no backend. Nothing ever leaves your machine.
- **Lockfile is the truth.** Resolves against `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` — where transitive attacks actually live — never `package.json` alone.
- **Day-zero capable.** Structural detection (execution surface + version anomalies) needs no advisory feed to fire.

## Incident day — zero install

```bash
npx lockwarden check node-ipc@9.1.6        # am I hit? every transitive path, from the lockfile
npx lockwarden check --incident <id>        # vendored IOC bundle for a named incident
npx lockwarden check axios --history        # was I *ever* exposed? exposure windows from git
```

Exit codes are the API: `0` clean · `1` hit at/above threshold · `2` execution error.

## Status

v0.1 — `check` is live. `audit` (execution-surface scoring + SARIF), `drift`, `scan`, and the GitHub Action are on the way. See the [spec](https://github.com/itsraghul/lockwarden/blob/main/docs/lockwarden-v1-spec.md).

## License

MIT
