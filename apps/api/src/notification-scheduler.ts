import {
  cardCycleView,
  findDiscordLinkByUserId,
  findUserById,
  getNotificationPreferences,
  listAccounts,
  listAuditSessions,
  listNotifiableUserIds,
  listOpenExpected,
  listRecentNotifications,
  listWebPushSubscriptions,
  newId,
  recordNotificationSent,
  removeWebPushSubscriptionByEndpoint,
  type Db,
} from '@okane-dokoitta/database';
import { civilDateFromInstant, formatCivilDate } from '@okane-dokoitta/domain';
import {
  cooldownMinutesFor,
  formatAmountForPrivacy,
  isQuietHours,
  minuteOfDayInTimeZone,
  shouldSend,
  type NotificationEventType,
  type PrivacyMode,
} from '@okane-dokoitta/notifications';
import { sendDiscordDirectMessage } from './discord-client.js';
import type { ApiEnv } from './env.js';
import { sendWebPush } from './web-push-client.js';

interface Candidate {
  eventType: NotificationEventType;
  dedupKey: string;
  /** cooldown 判斷的實體前綴（供多筆同類事件各自獨立冷卻）；cooldownMinutes=0 時不使用。 */
  entityPrefix: string;
  message: string;
}

const INTERVAL_MS = 60 * 60_000; // 1 小時；與 wrangler.jsonc 的 cron 頻率一致

/** Docker/Node 單體部署（ADR-004 的替代路徑）用：setInterval 版本，鏡射 retention.ts 的模式。 */
export function startNotificationScheduler(db: Db, env: ApiEnv): () => void {
  const run = () =>
    void runNotificationScan(db, env).catch((error: unknown) => {
      console.error(`[notifications] scan failed: ${error instanceof Error ? error.name : 'UnknownError'}`);
    });
  run();
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * 通知掃描主迴圈（DISCORD_INTEGRATION §5）：Cloudflare Cron 與 Docker setInterval 皆呼叫這個函式。
 * 目前已接的事件：card_statement_upcoming、card_due_upcoming、expected_overdue、subscription_due、
 * statement_ready、audit_discrepancy/audit_completed。
 * 尚未接（見 docs/OPEN_QUESTIONS.md）：low_balance_warning、price_stale、sync_failed、backup_failed
 * ——這些事件類型已在 packages/notifications 定義，但目前沒有資料來源可判斷「何時該觸發」。
 */
export async function runNotificationScan(db: Db, env: ApiEnv, now: Date = new Date()): Promise<{ usersScanned: number; sent: number }> {
  const userIds = await listNotifiableUserIds(db);
  let sent = 0;
  for (const userId of userIds) {
    sent += await scanUser(db, env, userId, now);
  }
  return { usersScanned: userIds.length, sent };
}

async function scanUser(db: Db, env: ApiEnv, userId: string, now: Date): Promise<number> {
  const user = await findUserById(db, userId);
  if (!user) return 0;
  const prefs = await getNotificationPreferences(db, userId);
  const minuteOfDay = minuteOfDayInTimeZone(now, user.ledgerTimeZone);
  if (isQuietHours(minuteOfDay, prefs.quietHoursStartMinute, prefs.quietHoursEndMinute)) return 0;

  const [link, subs] = await Promise.all([findDiscordLinkByUserId(db, userId), listWebPushSubscriptions(db, userId)]);
  // 提醒優先走 Discord（作者拍板）：Discord 可用就不重複打 Web Push，推播只在沒有 Discord 時補位。
  // ponytail: Discord 單次投遞失敗不會 fallback 到推播（dedup 已記錄）；要更強的保證再做投遞重試。
  const channels: Array<'discord' | 'web_push'> = [];
  if (prefs.discordEnabled && link && env.discord) channels.push('discord');
  else if (prefs.webPushEnabled && subs.length > 0 && env.webPush) channels.push('web_push');
  if (channels.length === 0) return 0;

  const today = civilDateFromInstant(now.toISOString(), user.ledgerTimeZone);
  const candidates = await detectCandidates(db, userId, today, prefs.privacyMode);

  let sent = 0;
  for (const candidate of candidates) {
    if (prefs.mutedEventTypes.includes(candidate.eventType)) continue;
    for (const channel of channels) {
      if (!(await allowedByDedupAndCooldown(db, userId, candidate, channel, now))) continue;
      const recorded = await recordNotificationSent(db, { id: newId(), userId, eventType: candidate.eventType, dedupKey: candidate.dedupKey, channel });
      if (!recorded) continue; // 已被搶先記錄（併發排程執行），視同已發送
      const delivered = await deliver(db, env, channel, link, subs, candidate.message);
      if (delivered) sent++;
    }
  }
  return sent;
}

async function allowedByDedupAndCooldown(
  db: Db,
  userId: string,
  candidate: Candidate,
  channel: 'discord' | 'web_push',
  now: Date,
): Promise<boolean> {
  const cooldownMinutes = cooldownMinutesFor(candidate.eventType);
  if (cooldownMinutes <= 0) return true; // recordNotificationSent 的 unique constraint 就是唯一把關
  const sinceIso = new Date(now.getTime() - cooldownMinutes * 60_000).toISOString();
  const recent = (await listRecentNotifications(db, userId, candidate.eventType, channel, sinceIso)).filter((r) =>
    r.dedupKey.startsWith(candidate.entityPrefix),
  );
  return shouldSend(
    { eventType: candidate.eventType, dedupKey: candidate.dedupKey, cooldownMinutes },
    recent.map((r) => ({ dedupKey: r.dedupKey, sentAt: r.sentAt.toISOString() })),
    now.toISOString(),
  );
}

async function deliver(
  db: Db,
  env: ApiEnv,
  channel: 'discord' | 'web_push',
  link: { discordUserId: string } | null,
  subs: Array<{ endpoint: string; p256dh: string; auth: string }>,
  message: string,
): Promise<boolean> {
  try {
    if (channel === 'discord' && link && env.discord) {
      await sendDiscordDirectMessage(env.discord.botToken, link.discordUserId, message);
      return true;
    }
    if (channel === 'web_push' && env.webPush) {
      let delivered = false;
      for (const sub of subs) {
        const { gone } = await sendWebPush(env.webPush, sub, message);
        if (gone) await removeWebPushSubscriptionByEndpoint(db, sub.endpoint);
        else delivered = true;
      }
      return delivered;
    }
    return false;
  } catch (err) {
    console.error(`[notifications] deliver via ${channel} failed -> ${err instanceof Error ? err.constructor.name : 'UnknownError'}`);
    return false;
  }
}

async function detectCandidates(
  db: Db,
  userId: string,
  today: ReturnType<typeof civilDateFromInstant>,
  privacy: PrivacyMode,
): Promise<Candidate[]> {
  const todayStr = formatCivilDate(today);
  const candidates: Candidate[] = [];

  // 信用卡結帳/繳款提醒
  const cardAccounts = (await listAccounts(db, userId)).filter((a) => a.subtype === 'credit_card');
  for (const account of cardAccounts) {
    const view = await cardCycleView(db, userId, account.id, today);
    if (!view) continue;
    const daysToStatement = daysBetween(todayStr, view.current.statementDate);
    if (daysToStatement === 2) {
      const total = view.current.postedMinor + view.current.pendingMinor - view.current.refundedMinor;
      candidates.push({
        eventType: 'card_statement_upcoming',
        entityPrefix: `card:${account.id}:stmt:`,
        dedupKey: `card:${account.id}:stmt:${view.current.statementDate}`,
        message: `💳 ${account.name}後天（${view.current.statementDate}）結帳，本期目前 ${formatAmountForPrivacy(total, view.currency, privacy)}。`,
      });
    }
    const daysToDue = daysBetween(todayStr, view.previous.dueDate);
    if ((daysToDue === 3 || daysToDue === 1) && view.previous.unpaidMinor > 0n) {
      candidates.push({
        eventType: 'card_due_upcoming',
        entityPrefix: `card:${account.id}:due:`,
        dedupKey: `card:${account.id}:due:${view.previous.dueDate}:offset:${daysToDue}`,
        message: `💳 ${account.name}${daysToDue === 1 ? '明天' : `${daysToDue}天後`}（${view.previous.dueDate}）繳款截止，未繳 ${formatAmountForPrivacy(view.previous.unpaidMinor, view.currency, privacy)}。`,
      });
    }
  }

  // 預計交易：逾期提醒、訂閱即將扣款
  const expected = await listOpenExpected(db, userId);
  for (const e of expected) {
    if (e.expectedDate < todayStr) {
      candidates.push({
        eventType: 'expected_overdue',
        entityPrefix: `expected:${e.id}:overdue:`,
        dedupKey: `expected:${e.id}:overdue:${todayStr}`,
        message: `🔍 有一筆預計交易（${e.expectedDate}）逾期未確認，到 PWA 或用 \`/finance confirm\` 處理一下？`,
      });
    } else if (e.ruleId && daysBetween(todayStr, e.expectedDate) === 1 && e.amountMinor !== null) {
      candidates.push({
        eventType: 'subscription_due',
        entityPrefix: `expected:${e.id}:due:`,
        dedupKey: `expected:${e.id}:due:${e.expectedDate}`,
        message: `📅 明天（${e.expectedDate}）有一筆訂閱預計扣款 ${formatAmountForPrivacy(e.amountMinor, e.currency, privacy)}。`,
      });
    }
  }

  // 帳單審計：新帳單待審、審計完成
  const sessions = await listAuditSessions(db, userId);
  for (const { session, statement } of sessions) {
    if (session.status === 'created') {
      candidates.push({
        eventType: 'statement_ready',
        entityPrefix: `statement:${statement.id}`,
        dedupKey: `statement:${statement.id}`,
        message: `📄 ${statement.statementDate} 的帳單已匯入，等你審計對帳。`,
      });
    } else if (session.status === 'completed') {
      const stats = session.stats as { discrepancyCount?: number };
      const discrepancies = stats.discrepancyCount ?? 0;
      candidates.push(
        discrepancies > 0
          ? {
              eventType: 'audit_discrepancy',
              entityPrefix: `session:${session.id}`,
              dedupKey: `session:${session.id}`,
              message: `🔍 ${statement.statementDate} 的帳單審計完成，找到 ${discrepancies} 筆差異，到 PWA 看看？`,
            }
          : {
              eventType: 'audit_completed',
              entityPrefix: `session:${session.id}`,
              dedupKey: `session:${session.id}`,
              message: `✅ ${statement.statementDate} 的帳單審計完成，帳都對上了。`,
            },
      );
    }
  }

  return candidates;
}

function daysBetween(fromStr: string, toStr: string): number {
  const from = new Date(`${fromStr}T00:00:00Z`).getTime();
  const to = new Date(`${toStr}T00:00:00Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}
