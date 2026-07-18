import { defineConfig } from 'drizzle-kit';

// Migration 一律經 drizzle-kit generate 產生並 code review（AGENTS §6）。
// migrate 使用 DDL 帳號（OKANE_DOKOITTA_MIGRATE_DATABASE_URL）；app 執行帳號無 DDL。
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  schemaFilter: ['okane_dokoitta'],
  dbCredentials: {
    url:
      process.env['OKANE_DOKOITTA_MIGRATE_DATABASE_URL'] ??
      process.env['OKANE_DOKOITTA_DATABASE_URL'] ??
      '',
  },
});
