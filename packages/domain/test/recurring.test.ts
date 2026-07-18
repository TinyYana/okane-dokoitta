import { describe, expect, it } from 'vitest';
import {
  DomainError,
  formatCivilDate,
  nextExpectedDate,
  parseCivilDate,
  validateSchedule,
} from '../src/index.js';

describe('週期規則展開（RECUR-1）', () => {
  it('每月固定日（Netflix 每月 22 號）', () => {
    const next = nextExpectedDate({ freq: 'monthly', interval: 1, dayOfMonth: 22 }, parseCivilDate('2026-07-22'));
    expect(formatCivilDate(next)).toBe('2026-08-22');
  });

  it('每月月底日在小月 clamp（31 號訂閱 → 2 月取月底）', () => {
    const next = nextExpectedDate({ freq: 'monthly', interval: 1, dayOfMonth: 31 }, parseCivilDate('2026-01-31'));
    expect(formatCivilDate(next)).toBe('2026-02-28');
    // clamp 後下一期回到 31 號（不因 2 月 28 而永久漂移）
    const after = nextExpectedDate({ freq: 'monthly', interval: 1, dayOfMonth: 31 }, next);
    expect(formatCivilDate(after)).toBe('2026-03-31');
  });

  it('每 2 個月', () => {
    const next = nextExpectedDate({ freq: 'monthly', interval: 2, dayOfMonth: 5 }, parseCivilDate('2026-07-05'));
    expect(formatCivilDate(next)).toBe('2026-09-05');
  });

  it('每週 / 每 2 週', () => {
    expect(formatCivilDate(nextExpectedDate({ freq: 'weekly', interval: 1 }, parseCivilDate('2026-07-17')))).toBe('2026-07-24');
    expect(formatCivilDate(nextExpectedDate({ freq: 'weekly', interval: 2 }, parseCivilDate('2026-07-17')))).toBe('2026-07-31');
  });

  it('每年（年費 1/31，平年 clamp）', () => {
    const next = nextExpectedDate({ freq: 'yearly', interval: 1, month: 2, dayOfMonth: 29 }, parseCivilDate('2024-02-29'));
    expect(formatCivilDate(next)).toBe('2025-02-28');
  });

  it('自訂天數（每 45 天）', () => {
    const next = nextExpectedDate({ freq: 'custom_days', interval: 1, customEveryDays: 45 }, parseCivilDate('2026-07-17'));
    expect(formatCivilDate(next)).toBe('2026-08-31');
  });

  it('無效 schedule 拒絕', () => {
    expect(() => validateSchedule({ freq: 'monthly', interval: 1 })).toThrow(DomainError);
    expect(() => validateSchedule({ freq: 'monthly', interval: 0, dayOfMonth: 5 })).toThrow(DomainError);
    expect(() => validateSchedule({ freq: 'yearly', interval: 1, dayOfMonth: 5 })).toThrow(DomainError);
    expect(() => validateSchedule({ freq: 'custom_days', interval: 1 })).toThrow(DomainError);
  });
});
