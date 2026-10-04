import { defineConfig } from 'eslint/config';
import root from '../../eslint.config.js';

export default defineConfig(
  ...root,
  {
    // The applier is the same package in the browser, the server, MCP and the CLI (FLR-ADR-010),
    // like the engine it is built on: no Node built-ins in its sources.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'packages/ops is isomorphic: no Node built-ins (FLR-ADR-010).' },
            {
              group: ['fs', 'path', 'crypto', 'os', 'buffer', 'stream', 'child_process', 'url', 'util'],
              message: 'packages/ops is isomorphic: no Node built-ins (FLR-ADR-010).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'packages/ops is isomorphic: use Uint8Array (FLR-ADR-010).' },
        { name: 'process', message: 'packages/ops is isomorphic: take configuration as arguments.' },
        { name: 'require', message: 'packages/ops is ESM.' },
        { name: '__dirname', message: 'packages/ops is isomorphic.' },
      ],
    },
  },
  {
    // Exact geometry indexes arrays whose lengths it has just established; see packages/engine.
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  { ignores: ['standard/**'] },
);
