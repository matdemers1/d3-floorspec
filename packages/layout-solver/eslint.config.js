import { defineConfig } from 'eslint/config';
import root from '../../eslint.config.js';

export default defineConfig(
  ...root,
  {
    // The solver runs wherever the engine does — editor, server, MCP, CLI (FLR-ADR-010): no Node
    // built-ins in its sources. The render script under scripts/ is Node-only and may use them.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'packages/layout-solver is isomorphic: no Node built-ins (FLR-ADR-010).' },
            {
              group: ['fs', 'path', 'crypto', 'os', 'buffer', 'stream', 'child_process', 'url', 'util'],
              message: 'packages/layout-solver is isomorphic: no Node built-ins (FLR-ADR-010).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'packages/layout-solver is isomorphic.' },
        { name: 'process', message: 'packages/layout-solver is isomorphic: take configuration as arguments.' },
        { name: 'require', message: 'packages/layout-solver is ESM.' },
        { name: '__dirname', message: 'packages/layout-solver is isomorphic.' },
      ],
      // Determinism (FLR-REQ-075 via Ops 1.3.2's spirit): same input, same candidates, byte for byte.
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'the solver is deterministic: use the seeded PRNG in src/random.ts.' },
        { object: 'Date', property: 'now', message: 'the solver is deterministic: no clock.' },
      ],
    },
  },
  {
    // Grid geometry indexes arrays whose lengths it has just established.
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
