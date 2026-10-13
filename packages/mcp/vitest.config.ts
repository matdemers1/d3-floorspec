import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // CI runs every package's tests at once on a two-core runner; compiling the tool schemas with Ajv
    // (server.test.ts) takes well under a second alone but outlasted the 5 s default there.
    testTimeout: 30_000,
  },
});
