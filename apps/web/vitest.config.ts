import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // CI runs every package's tests at once on a two-core runner: vitest's 5 s default
    // timed out tests that take well under a second alone (FLR-T-12.45).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['test/**/*.test.ts'],
    // @d3cloud/ui imports its stylesheet: let Vite load the package, so a test can render its components.
    server: { deps: { inline: ['@d3cloud/ui'] } },
  },
});
