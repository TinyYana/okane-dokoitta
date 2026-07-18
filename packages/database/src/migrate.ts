import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate as pgMigrate } from 'drizzle-orm/node-postgres/migrator';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Db } from './client.js';

// import.meta.url 在 Cloudflare Workers runtime 是 undefined。migrate 只在 Node 執行，
// 但 index.ts 會 re-export 本檔 → Worker 只是 import 就會跑到這行。不守住的話
// fileURLToPath(undefined) 會在 Worker 啟動時 throw，讓整包部署失敗（deploy version 失敗）。
const packageRoot = import.meta.url ? join(dirname(fileURLToPath(import.meta.url)), '..') : '.';

/** drizzle migrations 目錄（產生的 SQL 隨 package 發佈） */
export const MIGRATIONS_FOLDER = join(packageRoot, 'drizzle');

/** 以 DDL 帳號執行 pending migrations（DEPLOYMENT §3：使用者明確執行，不自動套用）。 */
export async function runMigrations(db: NodePgDatabase<Record<string, unknown>>): Promise<void> {
  await pgMigrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

/** 啟動時檢查是否有未套用的 migration（只檢查、不套用）。 */
export async function countPendingMigrations(db: Db): Promise<number> {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  const total = journal.entries.length;
  try {
    const result = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    const rows = (result as unknown as { rows?: Array<{ n: number }> }).rows ?? (result as unknown as Array<{ n: number }>);
    const applied = Array.isArray(rows) ? (rows[0]?.n ?? 0) : 0;
    return Math.max(0, total - applied);
  } catch {
    return total; // migrations 表不存在 = 全部未套用
  }
}
