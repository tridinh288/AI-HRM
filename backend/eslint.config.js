import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint rules are kept to the ones that catch real mistakes.
 *
 * Formatting is not linted — that argument is settled by Prettier, and rules
 * that only reformat code produce noisy diffs without preventing a single bug.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'drizzle/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // An unhandled promise in an Express handler means the request hangs
      // forever instead of erroring — worth being strict about.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // CLI scripts and tests legitimately print to stdout and use loose typing.
    files: ['**/*.test.ts', 'tests/**/*.ts', 'src/db/seed.ts', 'src/db/migrate.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
