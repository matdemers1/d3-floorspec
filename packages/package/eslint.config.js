import { defineConfig } from 'eslint/config';
import root from '../../eslint.config.js';

export default defineConfig(
  ...root,
  {
    // A package is opened in the browser (the import dialog), on the server and in the CLI
    // (FLR-ADR-010): no Node built-ins in its sources. The CLI does the file system.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'packages/package is isomorphic: no Node built-ins (FLR-ADR-010).' },
            {
              group: ['fs', 'path', 'crypto', 'os', 'buffer', 'stream', 'child_process', 'url', 'util', 'zlib'],
              message: 'packages/package is isomorphic: no Node built-ins (FLR-ADR-010).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'packages/package is isomorphic: use Uint8Array.' },
        { name: 'process', message: 'packages/package is isomorphic: take configuration as arguments.' },
        { name: 'require', message: 'packages/package is ESM.' },
        { name: '__dirname', message: 'packages/package is isomorphic.' },
      ],
      // The same document and files make the same archive, byte for byte: no clock.
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'a package is deterministic: no clock.' },
        { object: 'Math', property: 'random', message: 'a package is deterministic.' },
      ],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
