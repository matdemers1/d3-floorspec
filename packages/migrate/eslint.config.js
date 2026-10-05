import { defineConfig } from 'eslint/config';
import root from '../../eslint.config.js';

export default defineConfig(
  ...root,
  {
    // A migration runs in the editor, on the server, over MCP and in the CLI (FLR-ADR-010): no Node
    // built-ins in its sources, and nothing but the document and the target decides it (Core 20.1).
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'packages/migrate is isomorphic: no Node built-ins (FLR-ADR-010).' },
            {
              group: ['fs', 'path', 'crypto', 'os', 'buffer', 'stream', 'child_process', 'url', 'util', 'zlib'],
              message: 'packages/migrate is isomorphic: no Node built-ins (FLR-ADR-010).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'packages/migrate is isomorphic: use Uint8Array.' },
        { name: 'process', message: 'packages/migrate is isomorphic: take configuration as arguments.' },
        { name: 'require', message: 'packages/migrate is ESM.' },
        { name: '__dirname', message: 'packages/migrate is isomorphic.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'a migration is a function of the document and the target alone (Core 20.1).' },
        { object: 'Math', property: 'random', message: 'a migration is deterministic (Core 20.1).' },
      ],
    },
  },
  {
    files: ['test/**/*.ts', 'scripts/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  { ignores: ['standard/**'] },
);
