/**
 * 去重與冷卻判斷（DISCORD_INTEGRATION §5）：
 * - dedup：同一 dedup_key 已發送過 → 不重發（例如同一張卡同一結帳週期的提醒只發一次）。
 * - cooldown：即使 dedup_key 不同，同一 eventType 在 cooldown 內已發過 → 不重發（防止事件重複觸發洗版）。
 * 純函式：呼叫端先查好近期紀錄（同 user + eventType + channel），這裡只做決策。
 */
export interface NotificationCandidate {
  eventType: string;
  dedupKey: string;
  cooldownMinutes: number;
}

export interface RecentNotification {
  dedupKey: string;
  sentAt: string; // ISO
}

export function shouldSend(candidate: NotificationCandidate, recent: RecentNotification[], nowIso: string): boolean {
  if (recent.some((r) => r.dedupKey === candidate.dedupKey)) return false;
  if (candidate.cooldownMinutes <= 0) return true;
  const cooldownMs = candidate.cooldownMinutes * 60_000;
  const now = Date.parse(nowIso);
  return !recent.some((r) => now - Date.parse(r.sentAt) < cooldownMs);
}
