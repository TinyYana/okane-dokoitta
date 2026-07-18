import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { countPendingMigrations, createDb, createPool } from '@okane-dokoitta/database';
import { createApp } from './app.js';
import { readEnv } from './env.js';
import { startNotificationScheduler } from './notification-scheduler.js';
import { startRetentionPurge } from './retention.js';

const env = readEnv();
const pool = createPool(env.databaseUrl);
const db = createDb(pool);

// 啟動時檢查 pending migrations：不自動套用（DEPLOYMENT §3）
const pending = await countPendingMigrations(db);
if (pending > 0) {
  console.error(
    `[okane-dokoitta] 有 ${pending} 個未套用的 migration。請先備份，然後執行：pnpm --filter @okane-dokoitta/database migrate`,
  );
  process.exit(1);
}

const app = createApp(db, env);
startRetentionPurge(db, env);
startNotificationScheduler(db, env);

// 生產模式：同一個 server 供應 PWA 靜態檔（SPA fallback 到 index.html）
const webDist = env.webDistDir ?? resolve(import.meta.dirname, '../../web/dist');
if (existsSync(webDist)) {
  const root = resolve(webDist);
  app.use('*', serveStatic({ root }));
  app.get('*', serveStatic({ root, path: 'index.html' }));
  console.log(`[okane-dokoitta] serving PWA from ${root}`);
}

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`[okane-dokoitta] api listening on :${info.port}`);
});
