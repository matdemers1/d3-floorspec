import { defineConfig } from 'vitest/config';

// Whole sheets, packages and meshes are built per test: CI's runners are several times slower than a laptop.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
