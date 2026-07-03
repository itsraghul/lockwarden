import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  bundle: true,
  splitting: false,
  minify: false,
  sourcemap: false,
  clean: true,
  // The three runtime deps stay external so the installed tree remains
  // visibly tiny (`npm ls lockwarden`); everything else bundles into one
  // file for fast npx cold start. Vendored JSON data is inlined by esbuild.
  external: ['commander', 'yaml', 'semver'],
  banner: { js: '#!/usr/bin/env node' },
});
