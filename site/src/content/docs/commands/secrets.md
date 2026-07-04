---
title: lockwarden secrets
description: Minimal hardcoded-secret scan of the project and dependency install paths. A convenience, not the differentiator.
---

Minimal hardcoded-secret scan of the project and dependency install paths.

## Synopsis

```bash
npx lockwarden secrets [--dir <path>]
```

A regex + entropy scan for common credential patterns — in your project files and in
dependency install-path files. It exists because checking for leaked credentials is a
natural follow-up while you're already auditing a tree; it is deliberately **minimal** and
is not the reason to use lockwarden. If you need a dedicated secret scanner with a large
pattern catalogue, use one.

## Flags

`secrets` has no command-specific flags. All
[global flags](/getting-started/#global-flags) apply — in particular `--dir <path>` to
point at monorepo package roots.

## Examples

```bash
npx lockwarden secrets
npx lockwarden secrets --dir packages/api --dir packages/web
npx lockwarden secrets --json --ci
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No secrets found at or above `--threshold` |
| `1` | Findings at or above `--threshold` |
| `2` | Execution error |

## Notes

- Runs fully offline, always.
- Dependency install paths are included because 2026 malware families harvest
  credentials at install time — a hardcoded token inside `node_modules` is a signal
  worth surfacing while you're triaging.
