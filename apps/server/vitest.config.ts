import { defineConfig } from 'vitest/config';

// Named projects, because CI gates in layers: lint → conformance → unit → integration. The
// integration project is the only one that needs a database.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
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
