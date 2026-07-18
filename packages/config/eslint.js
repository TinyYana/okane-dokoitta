import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// Shared ESLint flat-config base for all workspace packages.
export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    // 只取經典兩條（rules-of-hooks / exhaustive-deps）；React Compiler 系列規則等導入 compiler 再開
    files: ['**/*.tsx', 'apps/web/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message: 'AGENTS §5: 金額禁止浮點數。使用 domain money module。',
        },
      ],
    },
  },
  {
    // AGENTS §4: packages/domain 不依賴任何其他 workspace package，不做 IO。
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@okane-dokoitta/*'], message: 'domain 不得依賴其他 workspace package' },
            { group: ['node:*', 'fs', 'path', 'http', 'https', 'crypto', 'child_process'], message: 'domain 是純 TS，不做 IO' },
          ],
        },
      ],
    },
  },
  {
    // AGENTS §4: packages/* 不得 import apps/*
    files: ['packages/**/*.ts', 'packages/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@okane-dokoitta/api', '@okane-dokoitta/web'], message: 'packages 不得 import apps' }] },
      ],
    },
  },
);
