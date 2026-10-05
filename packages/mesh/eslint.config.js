import { defineConfig } from 'eslint/config';
import root from '../../eslint.config.js';

export default defineConfig(
  ...root,
  {
    // The mesher indexes rings, triangles and vertex arrays whose lengths it has just established.
    // Under noUncheckedIndexedAccess each such index is `T | undefined`, and the non-null
    // assertion is the honest way to say it is in range — the engine's and the renderer's reasoning.
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    // Isomorphic like the engine (FLR-ADR-010): the same package in the browser and in Node.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'packages/mesh is isomorphic: no Node built-ins (FLR-ADR-010).' },
            { group: ['fs', 'path', 'crypto', 'os', 'buffer', 'stream', 'child_process', 'url', 'util'], message: 'packages/mesh is isomorphic: no Node built-ins (FLR-ADR-010).' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'packages/mesh is isomorphic: use Uint8Array (FLR-ADR-010).' },
        { name: 'process', message: 'packages/mesh is isomorphic: take configuration as arguments.' },
      ],
    },
  },
);
