/**
 * Quiet hours（DISCORD_INTEGRATION §5）：分鐘數區間（0-1439，本地民用時間），支援跨午夜（例：22:00–07:00）。
 * 任一端為 null＝未啟用。排程週期性重跑，quiet hours 期間跳過的通知在區間結束後的下一輪自然補發，
 * 不需要額外的延遲佇列。
 */
export function isQuietHours(nowMinuteOfDay: number, startMinute: number | null, endMinute: number | null): boolean {
  if (startMinute === null || endMinute === null) return false;
  if (startMinute === endMinute) return false; // 起訖相同視為未設定區間
  if (startMinute < endMinute) return nowMinuteOfDay >= startMinute && nowMinuteOfDay < endMinute;
  return nowMinuteOfDay >= startMinute || nowMinuteOfDay < endMinute; // 跨午夜
}

/** 依民用時區把 Date 換算成當地「一天中的第幾分鐘」。 */
export function minuteOfDayInTimeZone(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}
