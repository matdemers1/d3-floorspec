import { defineConfig } from 'eslint/config';
import root from '../../eslint.config.js';

export default defineConfig(
  ...root,
  {
    // The DSL compiles wherever the engine does — editor, server, MCP, CLI (FLR-ADR-010): no Node
    // built-ins in its sources. 
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'packages/dsl is isomorphic: no Node built-ins (FLR-ADR-010).' },
            {
              group: ['fs', 'path', 'crypto', 'os', 'buffer', 'stream', 'child_process', 'url', 'util'],
              message: 'packages/dsl is isomorphic: no Node built-ins (FLR-ADR-010).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'packages/dsl is isomorphic.' },
        { name: 'process', message: 'packages/dsl is isomorphic: take configuration as arguments.' },
        { name: 'require', message: 'packages/dsl is ESM.' },
        { name: '__dirname', message: 'packages/dsl is isomorphic.' },
      ],
      // Determinism (FLR-REQ-075 via Ops 1.3.2's spirit): same input, same candidates, byte for byte.
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'the DSL is deterministic.' },
        { object: 'Date', property: 'now', message: 'the DSL is deterministic: no clock.' },
      ],
    },
  },
  {
    // Geometry indexes arrays and maps whose contents it has just established.
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
