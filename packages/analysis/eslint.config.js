import { defineConfig } from 'eslint/config';
import root from '../../eslint.config.js';

export default defineConfig(
  ...root,
  {
    // The estimate runs wherever the engine does — the editor, the server, MCP (FLR-ADR-010): no
    // Node built-ins in its sources, and no clock or randomness, so the same plan and inputs always
    // give the same estimate.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'packages/analysis is isomorphic: no Node built-ins (FLR-ADR-010).' },
            {
              group: ['fs', 'path', 'crypto', 'os', 'buffer', 'stream', 'child_process', 'url', 'util'],
              message: 'packages/analysis is isomorphic: no Node built-ins (FLR-ADR-010).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'packages/analysis is isomorphic.' },
        { name: 'process', message: 'packages/analysis is isomorphic: take configuration as arguments.' },
        { name: 'require', message: 'packages/analysis is ESM.' },
        { name: '__dirname', message: 'packages/analysis is isomorphic.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'the estimate is deterministic.' },
        { object: 'Date', property: 'now', message: 'the estimate is deterministic: no clock.' },
      ],
    },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
