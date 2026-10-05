import { defineConfig } from 'eslint/config';
import root from '../../eslint.config.js';

export default defineConfig(...root, {
  // The drawings index rings, point lists and maps whose contents the engine has just derived (a
  // wall's face ends, the wall an opening is hosted on, the points of a dimension string). Under
  // noUncheckedIndexedAccess each such lookup is `T | undefined`, and the non-null assertion is the
  // honest way to say it is present — the same reasoning as render2d and the engine.
  files: ['src/export/**/*.ts', 'test/**/*.ts'],
  rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
});
