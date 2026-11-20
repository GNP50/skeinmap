// ESLint flat config. Type-aware rules are left out on purpose: they need a TS program
// per file and slow the run down a lot for little gain on this code base.
import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  globalIgnores([
    'dist/',
    'coverage/',
    'target/',
    'node_modules/',
    'src/wasm/pkg/',
    'docs/.vitepress/cache/',
    'docs/.vitepress/dist/',
    'docs/api/',
    'docs/public/demo/',
    'bench/results/',
    'bench/compare/dist/',
    'bench/compare/results/',
    '**/node_modules/',
  ]),
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  // Library code runs in browsers and workers (and in Node for tests and the CJS build).
  {
    files: ['src/**', 'examples/**', 'docs/**'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker },
    },
  },
  // Tooling runs in Node.
  {
    files: [
      'scripts/**',
      'bench/**',
      'crates/skeinmap-profile/**',
      'test/**',
      'docs/.vitepress/**',
      '*.config.{js,ts,mjs,cjs}',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.{tsx,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
)
