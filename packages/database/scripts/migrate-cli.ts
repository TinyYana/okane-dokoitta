/**
 * okane-dokoitta migrate（DEPLOYMENT §3）：明確執行、不自動套用。
 * 使用 DDL 帳號（OKANE_DOKOITTA_MIGRATE_DATABASE_URL；未設定時退回 DATABASE_URL）。
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { runMigrations } from '../src/migrate.js';

const url = process.env['OKANE_DOKOITTA_MIGRATE_DATABASE_URL'] ?? process.env['OKANE_DOKOITTA_DATABASE_URL'];
if (!url) {
  console.error('缺少 OKANE_DOKOITTA_MIGRATE_DATABASE_URL（或 OKANE_DOKOITTA_DATABASE_URL）');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
await runMigrations(drizzle(pool));
console.log('[okane-dokoitta] migrations 已套用完成');
await pool.end();
