import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { nodeCommands } from './test/browser-commands.js';

// Two projects over the same evaluator: `node` runs every test; `browser` runs the isomorphic ones
// in headless Chromium (FLR-ADR-010) — the measure tests and the whole Rules conformance suite,
// byte for byte, with the suite's files read in Node and handed to the browser.
export default defineConfig({
  test: {
    // CI runs every package's tests at once on a two-core runner: vitest's 5 s default
    // timed out tests that take well under a second alone (FLR-T-12.45).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.browser.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.node.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
            commands: nodeCommands,
          },
        },
      },
    ],
  },
});
