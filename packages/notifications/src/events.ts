/**
 * 事件類型目錄（DISCORD_INTEGRATION §5）。cooldownMinutes 是同一 eventType + 同一實體
 * （呼叫端在查詢近期紀錄時以 dedup_key 的實體前綴篩選）之間的最小間隔；dedup_key 本身另外
 * 防止「同一次發生」重複發送（例：同一結帳週期只提醒一次）。
 */
export const NOTIFICATION_EVENT_TYPES = {
  card_statement_upcoming: { label: '信用卡即將結帳', cooldownMinutes: 0 },
  card_due_upcoming: { label: '信用卡即將扣款/繳款截止', cooldownMinutes: 0 },
  low_balance_warning: { label: '扣款帳戶預估餘額不足', cooldownMinutes: 20 * 60 },
  subscription_due: { label: '固定訂閱即將扣款', cooldownMinutes: 0 },
  expected_overdue: { label: '預計交易逾期未確認', cooldownMinutes: 3 * 24 * 60 },
  statement_ready: { label: '新帳單等待審計', cooldownMinutes: 0 },
  audit_discrepancy: { label: '審計發現差額', cooldownMinutes: 0 },
  audit_completed: { label: '審計完成', cooldownMinutes: 0 },
  price_stale: { label: '投資價格過期', cooldownMinutes: 7 * 24 * 60 },
  sync_failed: { label: '雲同步失敗', cooldownMinutes: 6 * 60 },
  backup_failed: { label: '備份失敗', cooldownMinutes: 6 * 60 },
} as const;

export type NotificationEventType = keyof typeof NOTIFICATION_EVENT_TYPES;

export function cooldownMinutesFor(eventType: NotificationEventType): number {
  return NOTIFICATION_EVENT_TYPES[eventType].cooldownMinutes;
}
