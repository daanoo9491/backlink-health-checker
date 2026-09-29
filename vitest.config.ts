import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts so tests don't boot the Cloudflare runtime.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Worker tests start a real Postgres (PGlite) per test file. On a busy or
    // slower PC, with many test files starting at once, that can take several
    // seconds, so allow for it rather than failing on the 5-second default.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
