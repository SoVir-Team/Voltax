import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // Test against contract sources so no build step is needed first.
    alias: { '@voltax/contracts': fileURLToPath(new URL('../../shared/contracts/src/index.ts', import.meta.url)) },
  },
  test: { testTimeout: 15000, fileParallelism: false },
});
