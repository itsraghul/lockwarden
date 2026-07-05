---
title: Exit codes
description: The 0/1/2 exit-code contract — what each code means per command, and shell/CI snippets for composing lockwarden into pipelines.
---

Exit codes are the API. Every command returns exactly one of three codes, and every
command is CI-composable on that basis — human output is presentation, the exit code is
the verdict.

| Code | Meaning |
| --- | --- |
| `0` | Clean — no findings at or above [`--threshold`](/getting-started/#global-flags) (default: `high`) |
| `1` | Findings at or above `--threshold` |
| `2` | Execution error — the run itself failed; **never treat as clean** |

`--threshold` accepts severity names (`low`/`med`/`medium`/`high`/`critical`) or grade
letters (`B`/`C`/`D`/`F`). `A` is rejected — grade A means zero findings, which exit `0`
already expresses. Findings *below* the threshold are still reported in output; they
just don't flip the exit code.

## Per-command matrix

| Command | `0` | `1` | `2` (examples) |
| --- | --- | --- | --- |
| [`check`](/commands/check/) | No queried/bundled package resolves anywhere in the tree | At least one match in the resolved tree | No/unparseable lockfile · bad query · unknown incident id · lockfile not in git history (`--history`) |
| [`audit`](/commands/audit/) | No findings at/above threshold | Findings at/above threshold | Unparseable lockfile · lockfile missing at `--diff` ref · `--diff` + `--deep` together · invalid `--threshold` · integrity mismatch on a fetched tarball · network attempt under `--offline` |
| [`drift`](/commands/drift/) | No anomalies at/above threshold | Anomalies at/above threshold | Unknown `--base` ref · lockfile missing at base ref · unparseable lockfile |
| [`scan`](/commands/scan/) | No findings at/above threshold | Findings at/above threshold | Artifact not found/unreadable · `docker save` failed |
| [`secrets`](/commands/secrets/) | No findings at/above threshold | Findings at/above threshold | Execution error |

Note that `check`'s exit code ignores `--threshold` semantics in spirit — a hit is a
hit — while the scoring commands (`audit`, `drift`, `scan`, `secrets`) compare finding
severities against the threshold.

## Shell patterns

The if-form reads naturally because exit `0` is "clean":

```bash
if npx lockwarden check node-ipc@9.1.6 --ci; then
  echo "not affected"
else
  echo "affected or errored — see above"
fi
```

Three-way handling when "hit" and "broken run" must diverge (they should — an
unparseable lockfile during an incident is *not* good news):

```bash
npx lockwarden check --incident node-ipc-may26 --ci
case $? in
  0) echo "clean" ;;
  1) echo "HIT — escalate" ;;
  2) echo "check failed to run — investigate manually" ;;
esac
```

Chain gates so any failure stops the pipeline (`set -e` respects both `1` and `2`):

```bash
set -e
npx lockwarden audit --diff "$BASE_SHA" --ci
npx lockwarden drift --base "$BASE_SHA" --ci
```

Run the gate but never break the build (report-only mode) while still failing on broken
runs:

```bash
npx lockwarden audit --diff "$BASE_SHA" --ci || [ $? -eq 1 ]
```

## In CI systems

Every major CI fails a step on non-zero exit — no plugin or wrapper is needed. The
[GitHub Action](/github-action/) simply surfaces the same codes: exit `1` fails the
check, exit `2` errors it. Whether a failed check blocks the merge is your branch
protection policy — lockwarden [detects, it never enforces](/trust-model/#detection-not-enforcement).

Complete pipeline examples: [CI recipes](/guides/ci-recipes/).

## See also

- [JSON output](/reference/json-output/) — when you need *what* was found, not just
  whether.
- [Getting started → exit codes](/getting-started/#exit-codes-are-the-api).
