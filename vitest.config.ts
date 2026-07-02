import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve shared package to its TypeScript source so vitest never needs
      // packages/shared/dist to be prebuilt — npm test works on a fresh clone.
      '@cyber-shapes/shared': fileURLToPath(
        new URL('packages/shared/src/index.ts', import.meta.url)
      ),
    },
  },
  test: {
    environment: 'node',
    environmentMatchGlobs: [['**/*.dom.test.ts', 'jsdom']],
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.spec.ts',
      'packages/*/test/**/*.test.ts',
      'packages/*/test/**/*.spec.ts',
    ],
    passWithNoTests: true,
  },
});
