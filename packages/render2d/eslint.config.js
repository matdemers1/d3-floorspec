import { defineConfig } from 'eslint/config';
import root from '../../eslint.config.js';

export default defineConfig(...root, {
  // The renderer indexes rings and maps whose contents the engine has just derived (a wall's face
  // ends, the wall an opening is hosted on, the junctions of a level). Under noUncheckedIndexedAccess
  // each such lookup is `T | undefined`, and the non-null assertion is the honest way to say it is
  // present; a runtime check would only add an unreachable branch. Same reasoning as the engine.
  files: ['src/**/*.ts', 'test/**/*.ts'],
  rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
});
