import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', '.server-build', '.fitflow-data', 'coverage', 'public/sw.js', 'android/**', 'ios/**', 'test-results/**', 'playwright-report/**'] },
  { files: ['server/**/*.mjs'], extends: [js.configs.recommended], languageOptions: { ecmaVersion: 2022, globals: globals.node }, rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^(Settings|X)$' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
)
