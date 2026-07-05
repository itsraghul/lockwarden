import starlight from '@astrojs/starlight';
// @ts-check
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';

// https://astro.build/config
export default defineConfig({
  site: 'https://lockwarden.dev',
  integrations: [
    starlight({
      title: 'lockwarden',
      description:
        'Audit what your npm dependency tree can execute — and answer "am I hit?" in seconds during supply-chain incidents. Local-first, zero telemetry, zero accounts.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/itsraghul/lockwarden',
        },
      ],
      lastUpdated: true,
      customCss: ['./src/styles/custom.css'],
      plugins: [starlightLinksValidator()],
      sidebar: [
        {
          label: 'Start Here',
          items: [
            { label: 'Getting started', slug: 'getting-started' },
            { label: 'CI quickstart', slug: 'quickstart-ci' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'CI recipes', slug: 'guides/ci-recipes' },
            { label: 'Incident response', slug: 'guides/incident-response' },
            { label: 'Dependency review', slug: 'guides/dependency-review' },
          ],
        },
        {
          label: 'Commands',
          items: [
            { label: 'Overview', slug: 'commands' },
            { label: 'check', slug: 'commands/check' },
            { label: 'audit', slug: 'commands/audit' },
            { label: 'drift', slug: 'commands/drift' },
            { label: 'scan', slug: 'commands/scan' },
            { label: 'secrets', slug: 'commands/secrets' },
          ],
        },
        {
          label: 'CI & Automation',
          items: [{ label: 'GitHub Action', slug: 'github-action' }],
        },
        {
          label: 'Reference',
          items: [
            { label: 'JSON output', slug: 'reference/json-output' },
            { label: 'Exit codes', slug: 'reference/exit-codes' },
            { label: 'Scoring', slug: 'scoring' },
            { label: 'Trust model', slug: 'trust-model' },
            { label: 'Incident bundles', slug: 'incidents' },
          ],
        },
        {
          label: 'Project',
          items: [
            { label: 'Comparison', slug: 'project/comparison' },
            { label: 'Architecture decisions', slug: 'project/architecture-decisions' },
            { label: 'Contributing', slug: 'project/contributing' },
          ],
        },
      ],
    }),
  ],
});
