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
      editLink: {
        baseUrl: 'https://github.com/itsraghul/lockwarden/edit/main/site/',
      },
      customCss: ['./src/styles/custom.css'],
      plugins: [starlightLinksValidator()],
      sidebar: [
        {
          label: 'Start Here',
          items: [{ label: 'Getting started', slug: 'getting-started' }],
        },
        {
          label: 'Commands',
          items: [
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
            { label: 'Incident bundles', slug: 'incidents' },
            { label: 'Trust model', slug: 'trust-model' },
            { label: 'Scoring', slug: 'scoring' },
          ],
        },
      ],
    }),
  ],
});
