import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

/**
 * 共用 DB 型別：node-postgres 與 PGlite（測試用）的 drizzle 實例都符合。
 * repository / service 一律吃這個型別，含 transaction 內的 tx。
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema }) as unknown as Db;
}

/** 把 drizzle row 轉成可 JSON 化（bigint → 字串、Date → ISO）；金額禁止變成 number。 */
export function toJsonSafe<T>(value: T): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJsonSafe(v)]));
  }
  return value;
}
