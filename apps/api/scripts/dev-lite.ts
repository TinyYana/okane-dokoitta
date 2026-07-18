/**
 * dev-lite：無 Docker/Postgres 的本機試跑（PGlite = Postgres WASM，資料存 ./.dev-data）。
 * 僅供開發試用；正式自架一律用 PostgreSQL（docker-compose.yml）。
 *   pnpm --filter @okane-dokoitta/web build
 *   pnpm --filter @okane-dokoitta/api dev:lite
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { MIGRATIONS_FOLDER, schema, type Db } from '@okane-dokoitta/database';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { createApp } from '../src/app.js';
import { readEnv } from '../src/env.js';

const dataDir = resolve(import.meta.dirname, '..', '.dev-data');

const env = readEnv({
  ...process.env,
  OKANE_DOKOITTA_DATABASE_URL: 'pglite',
  OKANE_DOKOITTA_SESSION_SECRET: process.env['OKANE_DOKOITTA_SESSION_SECRET'] ?? 'dev-lite-only-secret-not-for-production!!',
  OKANE_DOKOITTA_DATA_DIR: process.env['OKANE_DOKOITTA_DATA_DIR'] ?? resolve(dataDir, 'files'),
});

// 先確認 port 沒被占再開 PGlite：兩個 dev-lite 同開同一資料目錄會踩爛 WAL（2026-07-18 發生過）
await new Promise<void>((ok, fail) => {
  const probe = createServer().once('error', fail).listen(env.port, () => probe.close(() => ok()));
}).catch(() => {
  console.error(`[okane-dokoitta] port ${env.port} 已被占用——是不是有另一個 dev:lite 還在跑？先關掉再重試。`);
  process.exit(1);
});

const pglite = new PGlite(dataDir);
const db = drizzle(pglite, { schema });
await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

const app = createApp(db as unknown as Db, env);
const webDist = resolve(import.meta.dirname, '../../web/dist');
if (existsSync(webDist)) {
  app.use('*', serveStatic({ root: webDist }));
  app.get('*', serveStatic({ root: webDist, path: 'index.html' }));
}

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`[okane-dokoitta] dev-lite on http://localhost:${info.port}（PGlite: ${dataDir}）`);
});
