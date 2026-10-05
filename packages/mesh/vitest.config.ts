import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { nodeCommands } from './test/browser-commands.js';

// Two projects over the same mesher: `node` runs every test; `browser` runs the isomorphic ones in
// headless Chromium, where manifold-3d's WASM is fetched as an asset rather than read from disk.
export default defineConfig({
  test: {
    // Meshing every conformance case and the generated houses takes a while under a cold cache.
    testTimeout: 120_000,
    projects: [
      {
        extends: true,
        test: { name: 'node', include: ['test/**/*.test.ts'], exclude: ['test/**/*.browser.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.node.test.ts'],
          browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: 'chromium' }], commands: nodeCommands },
        },
      },
    ],
  },
});
