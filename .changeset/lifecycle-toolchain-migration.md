---
"lockwarden": patch
---

lifecycle-scripts: a CHANGED install-script body no longer fires the delta Critical when both the old and new bodies are pure native-toolchain invocations (node-gyp, node-gyp-build, node-pre-gyp, prebuild-install, prebuildify, cmake-js with plain arguments) — toolchain migrations like bcrypt 6.0.0's node-pre-gyp → prebuildify swap are not payload changes. Freshly introduced hooks always signal, and any non-toolchain segment (e.g. `&& node payload.js`, the node-ipc shape) still fires — guarded by new corpus tamper fixtures. Validated by the full top-500 corpus run (gate PASS: 0 benign delta Criticals across 496 real version bumps; all 22 malicious fixtures grade F), which locks the scoring weights as no-longer-provisional.
