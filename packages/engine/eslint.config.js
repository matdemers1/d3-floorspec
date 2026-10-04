import { defineConfig } from 'eslint/config';
import root from '../../eslint.config.js';

export default defineConfig(
  ...root,
  {
    // The exact-geometry kernel indexes arrays whose lengths it has just established (a star's k
    // edges, a ring's n vertices, a coefficient vector of 2^k terms). Under noUncheckedIndexedAccess
    // every such index is `T | undefined`, and the non-null assertion is the honest way to say the
    // index is in range; a runtime check would only add an unreachable branch.
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  { ignores: ['standard/**'] },
);
