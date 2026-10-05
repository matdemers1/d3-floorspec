import { defineConfig } from 'eslint/config';
import root from '../../eslint.config.js';

export default defineConfig(
  ...root,
  {
    // The evaluator is the same package in the browser, the server, MCP and the CLI (FLR-ADR-010),
    // like the engine it is built on: no Node built-ins in its sources.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'packages/rules-engine is isomorphic: no Node built-ins (FLR-ADR-010).' },
            {
              group: ['fs', 'path', 'crypto', 'os', 'buffer', 'stream', 'child_process', 'url', 'util'],
              message: 'packages/rules-engine is isomorphic: no Node built-ins (FLR-ADR-010).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'packages/rules-engine is isomorphic: use Uint8Array (FLR-ADR-010).' },
        { name: 'process', message: 'packages/rules-engine is isomorphic: take configuration as arguments.' },
        { name: 'require', message: 'packages/ops is ESM.' },
        { name: '__dirname', message: 'packages/rules-engine is isomorphic.' },
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
