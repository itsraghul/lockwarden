import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'cli-unit',
          root: 'packages/cli',
          include: ['test/unit/**/*.test.ts', 'test/snapshots/**/*.test.ts'],
          setupFiles: ['test/setup.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'cli-integration',
          root: 'packages/cli',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/global-setup.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
