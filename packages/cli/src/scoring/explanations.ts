/**
 * Static, vendored knowledge behind `lockwarden explain` — what each finding
 * code detects, why it matters, and what to do about it. Severities are NOT
 * restated here: they are read live from weights.ts (the corpus-locked table)
 * so this file can never drift from the shipped weights.
 */
import type { AnalyzerId } from '../analyzers/types.ts';

export interface Layer1Explanation {
  /** Family id, e.g. "LW001". */
  id: string;
  analyzer: AnalyzerId;
  name: string;
  codes: { absolute?: string; delta?: string };
  detects: string;
  whyItMatters: string;
  whatToDo: string;
  /** Corpus-tuned compound elevation involving this analyzer, if any. */
  elevation?: string;
}

export interface Layer2Explanation {
  /** Code prefix, e.g. "LW2-OSV". */
  id: string;
  name: string;
  codePattern: string;
  detects: string;
  whyItMatters: string;
  whatToDo: string;
}

export const LAYER1_EXPLANATIONS: Layer1Explanation[] = [
  {
    id: 'LW001',
    analyzer: 'lifecycle-scripts',
    name: 'lifecycle install script',
    codes: { absolute: 'LW001-LIFECYCLE', delta: 'LW001D-LIFECYCLE-INTRODUCED' },
    detects:
      'preinstall/install/postinstall scripts in a resolved package (plus prepare, absolute mode only — prepare does not run on consumer installs of registry deps). Delta mode signals hooks newly introduced vs the previous version; a changed body is exempt only when both old and new bodies are pure native-toolchain invocations.',
    whyItMatters:
      'The classic execution vector: arbitrary code at install time, before you run anything. Legitimate packages carry install scripts forever — attacks INTRODUCE them, which is why the delta weight is far above the absolute one.',
    whatToDo:
      'Absolute: inventory-level — read the script body (npm pack, or the package page) and baseline it once reviewed. Delta: treat as an incident signal — diff the two versions before installing, and check `lockwarden incidents` / OSV for the package.',
  },
  {
    id: 'LW002',
    analyzer: 'binding-gyp',
    name: 'binding.gyp / node-gyp build hook',
    codes: { absolute: 'LW002-BINDING-GYP', delta: 'LW002D-BINDING-GYP-INTRODUCED' },
    detects:
      'A binding.gyp file (or node-gyp invocation) that makes npm run a native build at install time — code execution even with lifecycle scripts disabled (--ignore-scripts).',
    whyItMatters:
      'The node-ipc (May 2026) payload shipped via a binding.gyp hook precisely because teams that disable install scripts still run node-gyp. Native packages carry binding.gyp forever; its INTRODUCTION in an update is the attack shape.',
    whatToDo:
      'Absolute on a known native package: expected, baseline it. Introduced in a version bump of a previously-JS-only package: do not install — diff the versions and check advisories.',
  },
  {
    id: 'LW003',
    analyzer: 'agent-hooks',
    name: 'AI-agent hook / MCP manifest',
    codes: { absolute: 'LW003-AGENT-HOOK', delta: 'LW003D-AGENT-HOOK-INTRODUCED' },
    detects:
      'Executable AI-agent surface shipped inside a dependency: MCP server manifests, mcpServers config, agent hooks (e.g. SessionStart). Bare .claude/ files without executable surface do not signal.',
    whyItMatters:
      'Agent hooks execute when a developer merely opens a project with an AI coding tool — no install step needed. The Shai-Hulud worm wave (Jun 2026) moved to SessionStart hooks exactly because they outran install-script scanning.',
    whatToDo:
      'Dependencies have no business shipping agent hooks. Read the hook body; unless your org explicitly expects this package to provide MCP tooling, remove/pin and report it.',
  },
  {
    id: 'LW004',
    analyzer: 'ide-tasks',
    name: 'IDE task / folder-open file',
    codes: { absolute: 'LW004-IDE-TASK', delta: 'LW004D-IDE-TASK-INTRODUCED' },
    detects:
      'IDE task definitions (.vscode/tasks.json and equivalents) shipped inside a package — including tasks configured to run automatically on folder open.',
    whyItMatters:
      'A folderOpen task executes when the project is opened in the editor — before any build or install. Part of the Shai-Hulud playbook (Jun 2026).',
    whatToDo:
      'Dependencies should not ship IDE task files. Inspect the task command; treat an auto-run (folderOpen) task introduced in an update as malicious until proven otherwise.',
    elevation:
      'A delta ide-task that auto-executes on folder open is elevated to critical (Shai-Hulud shape; corpus-verified zero benign cost).',
  },
  {
    id: 'LW005',
    analyzer: 'size-delta',
    name: 'main-file size anomaly',
    codes: { delta: 'LW005D-SIZE-INTRODUCED' },
    detects:
      'The package main file growing >5× vs the previous version (delta modes only — there is no absolute notion of "too big").',
    whyItMatters:
      'Injected payloads inflate entry points; node-ipc-style compromises appended large blobs to the main file. Legitimate 5× jumps happen (bundling changes), so alone this is High, not Critical.',
    whatToDo:
      'Diff the main file between versions. Bundler/toolchain migration with a readable diff: accept. Unreadable appended blob: stop and check advisories.',
    elevation:
      'Size inflation AND new obfuscation markers in the same version is elevated to critical (the node-ipc shape; corpus-verified zero benign cost).',
  },
  {
    id: 'LW006',
    analyzer: 'dep-introduction',
    name: 'new transitive dep in a patch release',
    codes: { delta: 'LW006D-PATCH-DEP-INTRODUCED' },
    detects:
      'A brand-new transitive dependency appearing in a semver PATCH release of a package (delta modes only).',
    whyItMatters:
      'Patch releases promise "no new behavior" — smuggling a new dependency into one is how droppers arrive (the axios-mar26 phantom dep entered a tree this way). Corpus run: zero benign occurrences across 496 real version bumps.',
    whatToDo:
      'Look up the introduced package (`lockwarden check <pkg>` shows every path). If its existence surprises you, hold the upgrade and check the introduced package against advisories.',
  },
  {
    id: 'LW007',
    analyzer: 'obfuscation',
    name: 'obfuscation markers in install-path files',
    codes: { absolute: 'LW007-OBFUSCATION', delta: 'LW007D-OBFUSCATION-INTRODUCED' },
    detects:
      'Obfuscation signatures (eval chains, hex/base64 blobs, packed one-liners) in files reachable from install-time execution paths — lifecycle scripts and what they invoke.',
    whyItMatters:
      'Legitimate install scripts have no reason to be unreadable. Every 2026 malicious sample obfuscated its install path; benign packages that minify do so in their published lib, not their install hooks.',
    whatToDo:
      'Read the flagged file. Genuine minified vendored code on an install path: baseline after review. Introduced obfuscation in an update: treat as an incident signal.',
    elevation:
      'New obfuscation AND main-file size inflation in the same version is elevated to critical (the node-ipc shape).',
  },
  {
    id: 'LW008',
    analyzer: 'phantom-deps',
    name: 'phantom dependency',
    codes: { absolute: 'LW008-PHANTOM', delta: 'LW008D-PHANTOM-INTRODUCED' },
    detects:
      'A dependency declared in the manifest that the package never imports — present in your tree (and its install scripts run) while serving no code purpose.',
    whyItMatters:
      'The axios-mar26 dropper: plain-crypto-js was declared, executed its postinstall, then replaced its own files with clean decoys — visible only in the lockfile. A phantom dep is a free execution slot.',
    whatToDo:
      'Check why it is declared (`lockwarden check <pkg>` for the paths). Upstream sloppiness is common — baseline after review — but a phantom that ALSO carries execution surface deserves scrutiny.',
  },
  {
    id: 'LW009',
    analyzer: 'native-binary',
    name: 'prebuilt native binary',
    codes: { absolute: 'LW009-NATIVE-BINARY', delta: 'LW009D-NATIVE-BINARY-INTRODUCED' },
    detects:
      'Shipped .node binaries, or prebuilt-binary fetcher toolchains (prebuild-install, node-pre-gyp, node-gyp-build, prebuildify) in runtime deps/scripts.',
    whyItMatters:
      'A .node file loads native code at require-time with no binding.gyp and possibly no lifecycle script — invisible to LW001/LW002. Platform packages (esbuild, sharp) carry these legitimately forever; introduction in an update is the signal.',
    whatToDo:
      'Absolute on known platform packages: expected, baseline it. Introduced in an update of a previously-pure-JS package: do not install; verify the publisher and diff the release.',
  },
];

export const LAYER2_EXPLANATIONS: Layer2Explanation[] = [
  {
    id: 'LW2-OSV',
    name: 'known-bad package (OSV npm malware snapshot)',
    codePattern: 'LW2-OSV-<advisory-id>',
    detects:
      'The resolved name@version matches an entry in the vendored OSV.dev npm malware (MAL-*) snapshot, refreshed weekly via npm releases.',
    whyItMatters:
      'A published malware advisory for the exact package version in your tree. Always critical, regardless of the structural score.',
    whatToDo:
      'Treat as confirmed compromise: remove/pin away, rotate credentials the install could have reached, and use `lockwarden check <pkg> --history` for the exposure window. Check data freshness with `lockwarden incidents` or --max-advisory-age.',
  },
  {
    id: 'LW2-IOC',
    name: 'incident IOC match',
    codePattern: 'LW2-IOC-<incident-id> (…-FILE for a file-content sha256 match in scan)',
    detects:
      'The resolved name@version matches a vendored incident IOC bundle — or, in `scan`, a file inside the artifact matches a bundled sha256 file IOC.',
    whyItMatters:
      'You are directly implicated in a named supply-chain incident. Always critical. The -FILE variant means the payload bytes themselves are present in your artifact.',
    whatToDo:
      'Follow the incident runbook: `lockwarden check --incident <id>` for every entry path, `--history` for the exposure window, rotate exposed credentials. `lockwarden incidents` lists the bundles this build knows.',
  },
];
