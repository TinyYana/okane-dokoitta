import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  discordLinkTokens,
  discordLinks,
  notificationLog,
  notificationPreferences,
  webPushSubscriptions,
} from './schema.js';

export interface NewDiscordLink {
  id: string;
  userId: string;
  discordUserId: string;
  discordUsername: string;
}

/** 建立或（重新驗證後）更新連結；一個使用者只能有一個有效連結（schema unique）。 */
export async function upsertDiscordLink(db: Db, input: NewDiscordLink): Promise<void> {
  await db
    .insert(discordLinks)
    .values({ ...input, linkedAt: new Date(), revokedAt: null })
    .onConflictDoUpdate({
      target: discordLinks.userId,
      set: {
        discordUserId: input.discordUserId,
        discordUsername: input.discordUsername,
        linkedAt: new Date(),
        revokedAt: null,
      },
    });
}

export async function findDiscordLinkByUserId(db: Db, userId: string) {
  const [row] = await db
    .select()
    .from(discordLinks)
    .where(and(eq(discordLinks.userId, userId), isNull(discordLinks.revokedAt)));
  return row ?? null;
}

export async function findDiscordLinkByDiscordUserId(db: Db, discordUserId: string) {
  const [row] = await db
    .select()
    .from(discordLinks)
    .where(and(eq(discordLinks.discordUserId, discordUserId), isNull(discordLinks.revokedAt)));
  return row ?? null;
}

export async function revokeDiscordLink(db: Db, userId: string): Promise<void> {
  await db.update(discordLinks).set({ revokedAt: new Date() }).where(eq(discordLinks.userId, userId));
}

export interface NewDiscordLinkToken {
  id: string;
  tokenHash: string;
  discordUserId: string;
  discordUsername: string;
  expiresAt: Date;
}

export async function createDiscordLinkToken(db: Db, input: NewDiscordLinkToken): Promise<void> {
  await db.insert(discordLinkTokens).values(input);
}

/** 原子性消費一次性連結 token（RETURNING 避免同 token 被重複兌換的競態）。 */
export async function consumeDiscordLinkToken(
  db: Db,
  tokenHash: string,
): Promise<{ discordUserId: string; discordUsername: string } | null> {
  const [row] = await db
    .update(discordLinkTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(discordLinkTokens.tokenHash, tokenHash),
        isNull(discordLinkTokens.consumedAt),
        gt(discordLinkTokens.expiresAt, new Date()),
      ),
    )
    .returning({ discordUserId: discordLinkTokens.discordUserId, discordUsername: discordLinkTokens.discordUsername });
  return row ?? null;
}

export interface NotificationPreferencesValue {
  privacyMode: 'full' | 'fuzzy' | 'anomaly_only' | 'hidden';
  discordEnabled: boolean;
  webPushEnabled: boolean;
  quietHoursStartMinute: number | null;
  quietHoursEndMinute: number | null;
  mutedEventTypes: string[];
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferencesValue = {
  privacyMode: 'fuzzy',
  discordEnabled: true,
  webPushEnabled: true,
  quietHoursStartMinute: null,
  quietHoursEndMinute: null,
  mutedEventTypes: [],
};

/** 尚未設定過的使用者回傳預設值（Q7 推薦：fuzzy + 兩通道皆開），不強制先寫一列。 */
export async function getNotificationPreferences(db: Db, userId: string): Promise<NotificationPreferencesValue> {
  const [row] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
  return row
    ? {
        privacyMode: row.privacyMode,
        discordEnabled: row.discordEnabled,
        webPushEnabled: row.webPushEnabled,
        quietHoursStartMinute: row.quietHoursStartMinute,
        quietHoursEndMinute: row.quietHoursEndMinute,
        mutedEventTypes: row.mutedEventTypes,
      }
    : DEFAULT_NOTIFICATION_PREFERENCES;
}

/** set 只寫 patch 實際帶到的欄位，避免併發請求用自己讀到的舊值互相蓋掉（同 ai.ts saveAiSettings）。 */
export async function saveNotificationPreferences(
  db: Db,
  userId: string,
  patch: Partial<NotificationPreferencesValue>,
): Promise<NotificationPreferencesValue> {
  const merged = { ...(await getNotificationPreferences(db, userId)), ...patch };
  const [row] = await db
    .insert(notificationPreferences)
    .values({ userId, ...merged, updatedAt: new Date() })
    .onConflictDoUpdate({ target: notificationPreferences.userId, set: { ...patch, updatedAt: new Date() } })
    .returning();
  return {
    privacyMode: row!.privacyMode,
    discordEnabled: row!.discordEnabled,
    webPushEnabled: row!.webPushEnabled,
    quietHoursStartMinute: row!.quietHoursStartMinute,
    quietHoursEndMinute: row!.quietHoursEndMinute,
    mutedEventTypes: row!.mutedEventTypes,
  };
}

/** 給排程用：只掃有至少一個可用通道的使用者，避免白跑。 */
export async function listNotifiableUserIds(db: Db): Promise<string[]> {
  const [linked, subscribed] = await Promise.all([
    db.selectDistinct({ userId: discordLinks.userId }).from(discordLinks).where(isNull(discordLinks.revokedAt)),
    db.selectDistinct({ userId: webPushSubscriptions.userId }).from(webPushSubscriptions),
  ]);
  return [...new Set([...linked.map((r) => r.userId), ...subscribed.map((r) => r.userId)])];
}

/** dedup + cooldown 判斷用的近期紀錄（packages/notifications 的 shouldSend 純函式輸入）。 */
export async function listRecentNotifications(
  db: Db,
  userId: string,
  eventType: string,
  channel: 'discord' | 'web_push',
  sinceIso: string,
) {
  return db
    .select({ dedupKey: notificationLog.dedupKey, sentAt: notificationLog.sentAt })
    .from(notificationLog)
    .where(
      and(
        eq(notificationLog.userId, userId),
        eq(notificationLog.eventType, eventType),
        eq(notificationLog.channel, channel),
        gt(notificationLog.sentAt, new Date(sinceIso)),
      ),
    );
}

export interface NewNotificationLogEntry {
  id: string;
  userId: string;
  eventType: string;
  dedupKey: string;
  channel: 'discord' | 'web_push';
}

/** onConflictDoNothing：同一 (user, dedupKey, channel) 重複寫入視為已發送，不重發（DISCORD_INTEGRATION §5）。 */
export async function recordNotificationSent(db: Db, input: NewNotificationLogEntry): Promise<boolean> {
  const rows = await db
    .insert(notificationLog)
    .values(input)
    .onConflictDoNothing({ target: [notificationLog.userId, notificationLog.dedupKey, notificationLog.channel] })
    .returning({ id: notificationLog.id });
  return rows.length > 0;
}

export interface NewWebPushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function saveWebPushSubscription(db: Db, input: NewWebPushSubscription): Promise<void> {
  await db
    .insert(webPushSubscriptions)
    .values(input)
    .onConflictDoUpdate({
      target: webPushSubscriptions.endpoint,
      set: { userId: input.userId, p256dh: input.p256dh, auth: input.auth },
    });
}

export async function deleteWebPushSubscription(db: Db, userId: string, endpoint: string): Promise<void> {
  await db
    .delete(webPushSubscriptions)
    .where(and(eq(webPushSubscriptions.userId, userId), eq(webPushSubscriptions.endpoint, endpoint)));
}

export async function listWebPushSubscriptions(db: Db, userId: string) {
  return db.select().from(webPushSubscriptions).where(eq(webPushSubscriptions.userId, userId));
}

/** 移除失效訂閱（Web Push 端點回 404/410 時呼叫）。 */
export async function removeWebPushSubscriptionByEndpoint(db: Db, endpoint: string): Promise<void> {
  await db.delete(webPushSubscriptions).where(eq(webPushSubscriptions.endpoint, endpoint));
}
