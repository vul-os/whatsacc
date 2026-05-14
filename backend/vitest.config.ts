import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  test: {
    globals: true,
    fileParallelism: false,
    pool: 'threads',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
