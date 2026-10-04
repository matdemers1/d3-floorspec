import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/prisma/migrations/**',
      '**/src/generated/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'workers/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // The engine is the same package in the browser, the server, MCP and the CLI (FLR-ADR-010).
    // Its sources may not reach for anything only Node has; `tsconfig.build.json` loads no Node
    // types either, so a Buffer slipping through fails the build as well as this rule.
    files: ['packages/engine/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'packages/engine is isomorphic: no Node built-ins (FLR-ADR-010).' },
            {
              group: ['fs', 'path', 'crypto', 'os', 'buffer', 'stream', 'child_process', 'url', 'util'],
              message: 'packages/engine is isomorphic: no Node built-ins (FLR-ADR-010).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'packages/engine is isomorphic: use Uint8Array (FLR-ADR-010).' },
        { name: 'process', message: 'packages/engine is isomorphic: take configuration as arguments.' },
        { name: 'require', message: 'packages/engine is ESM.' },
        { name: '__dirname', message: 'packages/engine is isomorphic.' },
      ],
    },
  },
  {
    rules: {
      // An error that is swallowed becomes a silently wrong document.
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always'],
    },
  },
);
