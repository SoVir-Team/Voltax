// npm run lint: one flat config for every workspace. Type checking itself is `npm run typecheck`.
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/', '**/dist/', '**/out/', '**/.next/', '**/.dev-data/', '**/next-env.d.ts', 'docs/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Security: no dynamic code, ever.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      // A `let` assigned once but read earlier by closures (hub.ts's logger) cannot be a const.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
  {
    files: ['frontend/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      '@next/next/no-html-link-for-pages': 'off', // App Router only: there is no pages/ directory
      // The classic hook rules. The React Compiler rules (v7 "recommended") are not used: the apps are
      // not built with the React Compiler, and its idioms (refs, effects reading browser storage after
      // a static-export hydration) are intentional here.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['frontend/*/scripts/sw.template.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
);
