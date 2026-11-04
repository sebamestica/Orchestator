import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'fixtures/**', 'coverage/**', '.orq/**', 'apps/desktop/out/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // La interfaz no empaqueta código del núcleo: de src/core solo tipos.
    files: ['src/ui/**/*.{ts,tsx}', 'tests/ui/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/core/**'], message: 'La interfaz solo importa tipos de src/core (import type).', allowTypeImports: true }] },
      ],
    },
  },
);
