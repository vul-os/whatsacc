import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

// Frontend portal unit tests. Deliberately separate from backend/vitest.config.ts
// (that one tests the historical Cloudflare Workers reference backend; this one
// tests the code that actually ships — the portal that talks to gateway/).
export default defineConfig({
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
