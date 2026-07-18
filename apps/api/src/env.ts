import type { ImportBucket } from './file-store.js';

/** 環境變數（DEPLOYMENT §2；前綴 OKANE_DOKOITTA_，secrets 只在 env）。 */
export interface ApiEnv {
  databaseUrl: string;
  sessionSecret: string;
  baseUrl: string | null;
  ledgerTimeZone: string;
  port: number;
  webDistDir: string | null;
  registrationMode: 'open' | 'invite' | 'closed';
  fileKey: string | null;
  dataDir: string;
  importRetentionDays: number;
  importBucket: ImportBucket | null;
  /** 美股報價（選填）：Finnhub token。未設定時台股 TWSE 報價仍可用，美股會顯示設定提示。 */
  finnhubToken: string | null;
  /** M5：未設定時 Discord 相關路由回報功能未啟用（Q10，待作者建立 Discord application）。 */
  discord: { appId: string; publicKey: string; botToken: string; clientSecret: string } | null;
  /** M5：Web Push VAPID 金鑰對；未設定時訂閱/發送路由回報功能未啟用。 */
  webPush: { vapidPublicKey: string; vapidPrivateKey: string; contactEmail: string } | null;
}

export function readEnv(env: Record<string, string | undefined> = process.env): ApiEnv {
  const databaseUrl = env['OKANE_DOKOITTA_DATABASE_URL'];
  const sessionSecret = env['OKANE_DOKOITTA_SESSION_SECRET'];
  if (!databaseUrl) throw new Error('缺少 OKANE_DOKOITTA_DATABASE_URL');
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('OKANE_DOKOITTA_SESSION_SECRET 必須至少 32 字元的隨機值');
  }
  const registrationMode = env['OKANE_DOKOITTA_REGISTRATION_MODE'] ?? 'invite';
  if (!['open', 'invite', 'closed'].includes(registrationMode)) {
    throw new Error('OKANE_DOKOITTA_REGISTRATION_MODE 必須是 open、invite 或 closed');
  }
  const importRetentionDays = Number(env['OKANE_DOKOITTA_IMPORT_RETENTION_DAYS'] ?? 90);
  if (!Number.isInteger(importRetentionDays) || importRetentionDays < 1 || importRetentionDays > 3650) {
    throw new Error('OKANE_DOKOITTA_IMPORT_RETENTION_DAYS 必須是 1 到 3650 的整數');
  }
  const fileKey = env['OKANE_DOKOITTA_FILE_KEY'] || null;
  if (fileKey && fileKey.length < 32) throw new Error('OKANE_DOKOITTA_FILE_KEY 必須至少 32 字元');
  const [discordAppId, discordPublicKey, discordBotToken, discordClientSecret] = [
    env['OKANE_DOKOITTA_DISCORD_APP_ID'],
    env['OKANE_DOKOITTA_DISCORD_PUBLIC_KEY'],
    env['OKANE_DOKOITTA_DISCORD_BOT_TOKEN'],
    env['OKANE_DOKOITTA_DISCORD_CLIENT_SECRET'],
  ];
  const discord =
    discordAppId && discordPublicKey && discordBotToken && discordClientSecret
      ? { appId: discordAppId, publicKey: discordPublicKey, botToken: discordBotToken, clientSecret: discordClientSecret }
      : null;
  const [vapidPublicKey, vapidPrivateKey, contactEmail] = [
    env['OKANE_DOKOITTA_VAPID_PUBLIC_KEY'],
    env['OKANE_DOKOITTA_VAPID_PRIVATE_KEY'],
    env['OKANE_DOKOITTA_VAPID_CONTACT_EMAIL'],
  ];
  const webPush = vapidPublicKey && vapidPrivateKey && contactEmail ? { vapidPublicKey, vapidPrivateKey, contactEmail } : null;
  return {
    databaseUrl,
    sessionSecret,
    baseUrl: env['OKANE_DOKOITTA_BASE_URL'] ?? null,
    ledgerTimeZone: env['OKANE_DOKOITTA_TZ'] ?? 'Asia/Taipei',
    port: Number(env['OKANE_DOKOITTA_PORT'] ?? 3000),
    webDistDir: env['OKANE_DOKOITTA_WEB_DIST'] ?? null,
    registrationMode: registrationMode as ApiEnv['registrationMode'],
    fileKey,
    dataDir: env['OKANE_DOKOITTA_DATA_DIR'] ?? './data',
    importRetentionDays,
    importBucket: null,
    finnhubToken: env['OKANE_DOKOITTA_FINNHUB_TOKEN'] || null,
    discord,
    webPush,
  };
}
