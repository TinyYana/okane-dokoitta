import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createDb, createPool, MIGRATIONS_FOLDER, runMigrations, type Db } from '@okane-dokoitta/database';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { schema } from '@okane-dokoitta/database';
import type { ApiEnv } from '../src/env.js';

/**
 * L3 測試 DB：
 * - CI / 本地有 Postgres：OKANE_DOKOITTA_TEST_DATABASE_URL（真實 PostgreSQL，TESTING §L3）——
 *   每次呼叫都用 CREATE DATABASE 開一個全新資料庫，不是共用同一個 schema drop+recreate；
 *   有些測試檔（如 import.test.ts）一個檔案內就要兩個互不相通的「伺服器」，共用 schema 會讓
 *   兩邊互踩（第二個的 migrate 會把第一個剛建好的使用者一起沖掉）。
 *   ponytail：建立的資料庫不會自動砍掉，CI 的 postgres service container 每次 run 都是全新的，不會累積；
 *   若之後本機接真實 Postgres 重複跑測試需要清理，再補 afterAll drop database。
 * - 否則：PGlite（真 Postgres 編譯成 WASM 的 in-process 版；無 Docker 環境的本地驗證，天生每個實例互相獨立）
 */
export async function createTestDb(): Promise<Db> {
  const url = process.env['OKANE_DOKOITTA_TEST_DATABASE_URL'];
  if (url) {
    const admin = createPool(url);
    const dbName = `test_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`create database "${dbName}"`);
    await admin.end();
    const target = new URL(url);
    target.pathname = `/${dbName}`;
    const pool = createPool(target.toString());
    const db = createDb(pool);
    const { drizzle } = await import('drizzle-orm/node-postgres');
    await runMigrations(drizzle(pool));
    return db;
  }
  const pglite = new PGlite();
  const db = drizzlePglite(pglite, { schema });
  await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db as unknown as Db;
}

export function testEnv(): ApiEnv {
  return {
    databaseUrl: 'unused-in-tests',
    sessionSecret: 'test-session-secret-at-least-32-characters!!',
    baseUrl: null,
    ledgerTimeZone: 'Asia/Taipei',
    port: 3000,
    webDistDir: null,
    registrationMode: 'invite',
    fileKey: 'test-file-key-at-least-32-characters-long',
    // 每個測試檔一個獨立目錄：vitest 平行跑，共用目錄會被別檔的 beforeAll rm 掃掉（實際炸過）
    dataDir: `${process.cwd()}/.test-data/${randomUUID()}`,
    importRetentionDays: 90,
    importBucket: null,
    finnhubToken: null,
    discord: null,
    webPush: null,
  };
}

/** 簡易 cookie jar + csrf 的測試 client */
export class TestClient {
  cookie = '';
  csrfToken = '';

  constructor(
    private readonly appFetch: (req: Request) => Response | Promise<Response>,
    private readonly clientIp = 'local',
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { 'x-forwarded-for': this.clientIp };
    if (this.cookie) headers['cookie'] = this.cookie;
    if (this.csrfToken) headers['x-odk-csrf'] = this.csrfToken;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.appFetch(
      new Request(`http://localhost${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0] ?? '';
    return res;
  }

  get(path: string) {
    return this.request('GET', path);
  }

  post(path: string, body?: unknown) {
    return this.request('POST', path, body);
  }

  /** 給需要自訂 header（例如 Discord 簽章）與逐字 raw body 的測試用，繞過自動 JSON 包裝。 */
  async appFetchRaw(path: string, headers: Record<string, string>, rawBody: string): Promise<Response> {
    return this.appFetch(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'x-forwarded-for': this.clientIp, 'content-type': 'application/json', ...headers },
        body: rawBody,
      }),
    );
  }
}
