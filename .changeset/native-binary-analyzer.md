---
"lockwarden": minor
---

New analyzer `native-binary` (LW009/LW009D): prebuilt native-binary execution surface — shipped `.node` files (native code that loads at require-time with no `binding.gyp` and possibly no lifecycle script) and prebuilt-binary fetcher toolchains (`prebuild-install`, `node-pre-gyp`, `@mapbox/node-pre-gyp`, `node-gyp-build`, `prebuildify`) in runtime deps or scripts. Corpus-gated weights: absolute Low, delta Critical (0/60 benign noise, all synthetic fixtures grade F). Trees shipping platform binaries (sharp, esbuild/rollup platform packages, fsevents) gain Low findings — this can flip exit codes only for `--threshold low` runs.
