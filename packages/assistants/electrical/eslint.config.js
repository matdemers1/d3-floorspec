import { defineConfig } from 'eslint/config';
import root from '../../../eslint.config.js';

export default defineConfig(
  ...root,
  {
    // The assistant runs wherever the engine does — editor, server, MCP (FLR-ADR-010): no Node
    // built-ins in its sources.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'the electrical assistant is isomorphic: no Node built-ins (FLR-ADR-010).' },
            { group: ['fs', 'path', 'crypto', 'os', 'buffer', 'stream', 'child_process', 'url', 'util'], message: 'the electrical assistant is isomorphic: no Node built-ins (FLR-ADR-010).' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'the electrical assistant is isomorphic.' },
        { name: 'process', message: 'the electrical assistant is isomorphic: take configuration as arguments.' },
      ],
      // Deterministic: the same plan and defaults give the same batch, byte for byte.
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'the assistant is deterministic.' },
        { object: 'Date', property: 'now', message: 'the assistant is deterministic: no clock.' },
        { object: 'Math', property: 'hypot', message: 'Math.hypot is not correctly rounded everywhere: use exact integer arithmetic.' },
      ],
    },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
