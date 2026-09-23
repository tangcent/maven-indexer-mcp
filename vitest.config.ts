import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Tests exercise engine SOURCE, not its build output, so `vitest run`
      // works without `npm run build` first (and always covers current code).
      '@maven-indexer/engine': resolve(root, 'packages/engine/src/index.ts'),
    },
  },
  test: {
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
