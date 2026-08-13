import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint rules chosen to protect the properties this codebase depends on, rather
 * than to enforce style (Prettier handles style).
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/src-tauri/target/**',
      '**/src-tauri/gen/**',
      'apps/desktop/dist/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // Development rule 12: keep tool input/output strongly typed.
      '@typescript-eslint/no-explicit-any': 'error',

      // Unused values are usually a half-finished edit. Underscore opts out.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // Type-only imports must be marked: `verbatimModuleSyntax` is on, and an
      // unmarked type import becomes a real runtime import that can pull the
      // whole shared package into the bundle.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // Development rule 14: cancellation everywhere. A floating promise is a
      // task nobody can cancel or await, which is how agents leak work.
      '@typescript-eslint/no-floating-promises': 'off', // needs type-aware linting; see below

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off', // the transport deliberately rebinds console
    },
  },

  // stdout is the IPC channel (ADR-0003). Nothing in the core may write to it.
  {
    files: ['packages/core/src/**/*.ts'],
    ignores: ['packages/core/src/transport/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'stdout',
          message:
            'stdout carries the sidecar IPC protocol (ADR-0003). Use the logger, which writes to a file and stderr.',
        },
      ],
    },
  },

  {
    files: ['**/test/**/*.ts', 'scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  // Plain Node scripts. Declared explicitly rather than adding the `globals`
  // package for one small list (development rule 20).
  {
    files: ['scripts/**/*.mjs', '*.config.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
      },
    },
  },
);
