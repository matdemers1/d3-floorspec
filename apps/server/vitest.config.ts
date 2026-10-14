import { defineConfig } from 'vitest/config';

// Named projects, because CI gates in layers: lint → conformance → unit → integration. The
// integration project is the only one that needs a database.
export default defineConfig({
  test: {
    projects: [
      // CI runs every package's tests at once on a two-core runner: vitest's 5 s default is too tight
      // there (FLR-T-12.45).
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 } },
      {
        test: {
          name: 'integration',
          // test/no-telemetry.test.ts boots the app under a network interception layer (FLR-T-12.3).
          include: ['test/integration/**/*.test.ts', 'test/no-telemetry.test.ts'],
          // Creates the database if needed and migrates it, so a dropped volume costs nothing.
          globalSetup: ['test/integration/global-setup.ts'],
          // A shared database makes these order-dependent; they run one file at a time.
          fileParallelism: false,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
