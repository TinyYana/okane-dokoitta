import base from './packages/config/eslint.js';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/dev-dist/**', '**/drizzle/**'],
  },
  ...base,
];
