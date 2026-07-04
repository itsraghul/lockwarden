# lockwarden GitHub Action

Two lines of YAML: execution-surface review on every dependency bump, findings
in the Security tab you already use. No account, no telemetry — analysis runs
entirely on your runner.

```yaml
# .github/workflows/lockwarden.yml
name: lockwarden
on:
  pull_request:
    paths:
      - '**/package-lock.json'
      - '**/pnpm-lock.yaml'
      - '**/yarn.lock'
permissions:
  contents: read
  security-events: write # SARIF upload
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # --diff needs the base ref
      - uses: itsraghul/lockwarden/packages/action@v1
        with:
          diff-base: ${{ github.event.pull_request.base.sha }}
```

`--diff` scores only the packages whose resolved version changed — seconds, and
findings are about what the bump *introduced* (new install script, new
binding.gyp, size explosion), not noise about what always existed.

| input | default | |
|---|---|---|
| `command` | `audit` | `audit` or `check` |
| `diff-base` | — | git ref for delta scoring; omit for a full absolute scan |
| `threshold` | `high` | severity that fails the check |
| `sarif` | `true` | upload to the GitHub Security tab |
| `version` | pinned | exact CLI version the action runs |
