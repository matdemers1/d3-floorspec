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
          include: ['test/integration/**/*.test.ts'],
          fileParallelism: false,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
