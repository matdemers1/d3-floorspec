import { defineConfig } from 'eslint/config';
import root from '../../eslint.config.js';

export default defineConfig(...root, {
  // Tests index arrays they have just filtered to be non-empty; see packages/engine/eslint.config.js.
  files: ['test/**/*.ts'],
  rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
});
