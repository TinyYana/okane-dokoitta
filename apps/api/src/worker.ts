import { createDb, createPool } from '@okane-dokoitta/database';
import { createApp } from './app.js';
import { readEnv, type ApiEnv } from './env.js';
import type { ImportBucket } from './file-store.js';
import { runNotificationScan } from './notification-scheduler.js';
import { purgeExpiredImports } from './retention.js';

const NOTIFICATION_SCAN_CRON = '7 * * * *'; // 每小時；見 wrangler.jsonc triggers.crons

interface HyperdriveBinding {
  connectionString: string;
}

interface WorkerBindings {
  HYPERDRIVE: HyperdriveBinding;
  IMPORTS: ImportBucket;
  OKANE_DOKOITTA_SESSION_SECRET: string;
  OKANE_DOKOITTA_FILE_KEY?: string;
  OKANE_DOKOITTA_REGISTRATION_MODE?: string;
  OKANE_DOKOITTA_TZ?: string;
  OKANE_DOKOITTA_IMPORT_RETENTION_DAYS?: string;
  OKANE_DOKOITTA_FINNHUB_TOKEN?: string;
  // M5：Discord（Q10 待作者建立 application）與 Web Push VAPID，皆選填 —— 缺任一組即該功能停用
  OKANE_DOKOITTA_DISCORD_APP_ID?: string;
  OKANE_DOKOITTA_DISCORD_PUBLIC_KEY?: string;
  OKANE_DOKOITTA_DISCORD_BOT_TOKEN?: string;
  OKANE_DOKOITTA_DISCORD_CLIENT_SECRET?: string;
  OKANE_DOKOITTA_VAPID_PUBLIC_KEY?: string;
  OKANE_DOKOITTA_VAPID_PRIVATE_KEY?: string;
  OKANE_DOKOITTA_VAPID_CONTACT_EMAIL?: string;
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface ScheduledController {
  cron: string;
}

function apiEnv(bindings: WorkerBindings, request?: Request): ApiEnv {
  const env = readEnv({
    OKANE_DOKOITTA_DATABASE_URL: bindings.HYPERDRIVE.connectionString,
    OKANE_DOKOITTA_SESSION_SECRET: bindings.OKANE_DOKOITTA_SESSION_SECRET,
    OKANE_DOKOITTA_FILE_KEY: bindings.OKANE_DOKOITTA_FILE_KEY,
    OKANE_DOKOITTA_REGISTRATION_MODE: bindings.OKANE_DOKOITTA_REGISTRATION_MODE,
    OKANE_DOKOITTA_TZ: bindings.OKANE_DOKOITTA_TZ,
    OKANE_DOKOITTA_IMPORT_RETENTION_DAYS: bindings.OKANE_DOKOITTA_IMPORT_RETENTION_DAYS,
    OKANE_DOKOITTA_FINNHUB_TOKEN: bindings.OKANE_DOKOITTA_FINNHUB_TOKEN,
    OKANE_DOKOITTA_BASE_URL: request ? new URL(request.url).origin : undefined,
    OKANE_DOKOITTA_DISCORD_APP_ID: bindings.OKANE_DOKOITTA_DISCORD_APP_ID,
    OKANE_DOKOITTA_DISCORD_PUBLIC_KEY: bindings.OKANE_DOKOITTA_DISCORD_PUBLIC_KEY,
    OKANE_DOKOITTA_DISCORD_BOT_TOKEN: bindings.OKANE_DOKOITTA_DISCORD_BOT_TOKEN,
    OKANE_DOKOITTA_DISCORD_CLIENT_SECRET: bindings.OKANE_DOKOITTA_DISCORD_CLIENT_SECRET,
    OKANE_DOKOITTA_VAPID_PUBLIC_KEY: bindings.OKANE_DOKOITTA_VAPID_PUBLIC_KEY,
    OKANE_DOKOITTA_VAPID_PRIVATE_KEY: bindings.OKANE_DOKOITTA_VAPID_PRIVATE_KEY,
    OKANE_DOKOITTA_VAPID_CONTACT_EMAIL: bindings.OKANE_DOKOITTA_VAPID_CONTACT_EMAIL,
  });
  return { ...env, dataDir: '/tmp/okane-dokoitta', importBucket: bindings.IMPORTS };
}

async function withDatabase<T>(bindings: WorkerBindings, run: (db: ReturnType<typeof createDb>) => Promise<T>): Promise<T> {
  const pool = createPool(bindings.HYPERDRIVE.connectionString);
  try {
    return await run(createDb(pool));
  } finally {
    await pool.end();
  }
}

export default {
  fetch(request: Request, bindings: WorkerBindings): Promise<Response> {
    return withDatabase(bindings, async (db) => await createApp(db, apiEnv(bindings, request)).fetch(request));
  },

  scheduled(controller: ScheduledController, bindings: WorkerBindings, context: WorkerExecutionContext): void {
    if (controller.cron === NOTIFICATION_SCAN_CRON) {
      context.waitUntil(withDatabase(bindings, (db) => runNotificationScan(db, apiEnv(bindings))));
    } else {
      context.waitUntil(withDatabase(bindings, (db) => purgeExpiredImports(db, apiEnv(bindings))));
    }
  },
};
