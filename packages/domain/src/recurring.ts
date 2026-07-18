import { addDays, addMonths, clampToMonthEnd, type CivilDate } from './dates.js';
import { DomainError } from './errors.js';

/** RECUR-1/2：固定或浮動金額、每週/每月/每年/自訂天數週期。 */
export const RECUR_FREQS = ['weekly', 'monthly', 'yearly', 'custom_days'] as const;
export type RecurFreq = (typeof RECUR_FREQS)[number];

export interface RecurringSchedule {
  freq: RecurFreq;
  /** 每 interval 個週期一次（weekly=每 n 週、monthly=每 n 月…），預設 1 */
  interval: number;
  dayOfMonth?: number | undefined; // monthly / yearly
  month?: number | undefined; // yearly（1–12）
  customEveryDays?: number | undefined; // custom_days
}

export function validateSchedule(schedule: RecurringSchedule): void {
  if (!Number.isInteger(schedule.interval) || schedule.interval < 1) {
    throw new DomainError('SCHEDULE_INVALID', `interval 必須是正整數: ${schedule.interval}`);
  }
  switch (schedule.freq) {
    case 'weekly':
      return;
    case 'monthly':
      if (!schedule.dayOfMonth || schedule.dayOfMonth < 1 || schedule.dayOfMonth > 31) {
        throw new DomainError('SCHEDULE_INVALID', 'monthly 需要 dayOfMonth (1–31)');
      }
      return;
    case 'yearly':
      if (!schedule.month || schedule.month < 1 || schedule.month > 12 || !schedule.dayOfMonth || schedule.dayOfMonth < 1 || schedule.dayOfMonth > 31) {
        throw new DomainError('SCHEDULE_INVALID', 'yearly 需要 month (1–12) 與 dayOfMonth (1–31)');
      }
      return;
    case 'custom_days':
      if (!schedule.customEveryDays || schedule.customEveryDays < 1) {
        throw new DomainError('SCHEDULE_INVALID', 'custom_days 需要 customEveryDays ≥ 1');
      }
      return;
  }
}

/**
 * 下一個預計日：從 current（上一個預計日）推進一個週期。
 * 月底日（29–31）在小月 clamp 到月底。
 */
export function nextExpectedDate(schedule: RecurringSchedule, current: CivilDate): CivilDate {
  validateSchedule(schedule);
  switch (schedule.freq) {
    case 'weekly':
      return addDays(current, 7 * schedule.interval);
    case 'monthly': {
      const advanced = addMonths(current, schedule.interval);
      return clampToMonthEnd(advanced.year, advanced.month, schedule.dayOfMonth ?? current.day);
    }
    case 'yearly': {
      const year = current.year + schedule.interval;
      return clampToMonthEnd(year, schedule.month ?? current.month, schedule.dayOfMonth ?? current.day);
    }
    case 'custom_days':
      return addDays(current, schedule.customEveryDays ?? 1);
  }
}

/** expected_transactions.status：scheduled → matched → confirmed；scheduled → missed | skipped（DATA_MODEL §3.6）。
 *  M1 手動確認（RECUR-5）：scheduled 可直接 confirmed；missed 補確認也允許。 */
export const EXPECTED_STATUSES = ['scheduled', 'matched', 'confirmed', 'missed', 'skipped'] as const;
export type ExpectedStatus = (typeof EXPECTED_STATUSES)[number];

const EXPECTED_TRANSITIONS: Record<ExpectedStatus, readonly ExpectedStatus[]> = {
  scheduled: ['matched', 'confirmed', 'missed', 'skipped'],
  matched: ['confirmed'],
  missed: ['confirmed', 'skipped'],
  confirmed: [],
  skipped: [],
};

export function assertExpectedTransition(from: ExpectedStatus, to: ExpectedStatus): void {
  if (!EXPECTED_TRANSITIONS[from].includes(to)) {
    throw new DomainError('INVALID_STATUS_TRANSITION', `預計交易狀態不可從 ${from} 轉為 ${to}`);
  }
}
