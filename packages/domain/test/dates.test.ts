import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  civilDateFromInstant,
  clampToMonthEnd,
  computeCardCycle,
  computePreviousCardCycle,
  DomainError,
  formatCivilDate,
  parseCivilDate,
  instantFromCivilDate,
} from '../src/index.js';

describe('民用日期基礎', () => {
  it('解析與格式化往返', () => {
    expect(formatCivilDate(parseCivilDate('2026-07-17'))).toBe('2026-07-17');
    expect(formatCivilDate(parseCivilDate('2024-02-29'))).toBe('2024-02-29'); // 閏年
  });

  it('無效日期拒絕', () => {
    for (const bad of ['2026-13-01', '2026-02-30', '2025-02-29', '2026-1-1', 'abc', '2026/07/17']) {
      expect(() => parseCivilDate(bad), bad).toThrow(DomainError);
    }
  });

  it('addDays 跨月跨年', () => {
    expect(formatCivilDate(addDays(parseCivilDate('2026-12-31'), 1))).toBe('2027-01-01');
    expect(formatCivilDate(addDays(parseCivilDate('2026-03-01'), -1))).toBe('2026-02-28');
    expect(formatCivilDate(addDays(parseCivilDate('2024-03-01'), -1))).toBe('2024-02-29');
  });

  it('addMonths 月底 clamp（1/31 +1mo → 2/28）', () => {
    expect(formatCivilDate(addMonths(parseCivilDate('2026-01-31'), 1))).toBe('2026-02-28');
    expect(formatCivilDate(addMonths(parseCivilDate('2024-01-31'), 1))).toBe('2024-02-29');
    expect(formatCivilDate(addMonths(parseCivilDate('2026-03-31'), 1))).toBe('2026-04-30');
  });
});

describe('clampToMonthEnd（DATA_MODEL §6：結帳日 31 在小月取月底）', () => {
  it('大月不動、小月取月底', () => {
    expect(clampToMonthEnd(2026, 7, 31)).toEqual({ year: 2026, month: 7, day: 31 });
    expect(clampToMonthEnd(2026, 4, 31)).toEqual({ year: 2026, month: 4, day: 30 });
    expect(clampToMonthEnd(2026, 2, 31)).toEqual({ year: 2026, month: 2, day: 28 });
    expect(clampToMonthEnd(2024, 2, 31)).toEqual({ year: 2024, month: 2, day: 29 });
  });
});

describe('civilDateFromInstant（時區邊界：TESTING L1 指定案例）', () => {
  it('台北 23:50 的消費落在當天', () => {
    // 2026-07-17T15:50Z = 台北 2026-07-17 23:50
    expect(formatCivilDate(civilDateFromInstant('2026-07-17T15:50:00Z'))).toBe('2026-07-17');
  });

  it('台北 00:10 落在隔天（UTC 前一日）', () => {
    // 2026-07-17T16:10Z = 台北 2026-07-18 00:10
    expect(formatCivilDate(civilDateFromInstant('2026-07-17T16:10:00Z'))).toBe('2026-07-18');
  });

  it('可指定其他帳本時區', () => {
    expect(formatCivilDate(civilDateFromInstant('2026-07-17T15:50:00Z', 'UTC'))).toBe('2026-07-17');
    expect(formatCivilDate(civilDateFromInstant('2026-07-17T23:30:00Z', 'Asia/Tokyo'))).toBe('2026-07-18');
  });

  it('無效時間點拒絕', () => {
    expect(() => civilDateFromInstant('not-a-date')).toThrow(DomainError);
  });
});

describe('instantFromCivilDate', () => {
  it.each(['Asia/Taipei', 'America/New_York', 'Pacific/Kiritimati'])(
    '%s 轉成時間點後仍是同一個帳本日期',
    (timeZone) => {
      const date = parseCivilDate('2026-07-20');
      expect(formatCivilDate(civilDateFromInstant(instantFromCivilDate(date, timeZone), timeZone))).toBe('2026-07-20');
    },
  );
});

describe('信用卡週期（ACCT-5、F3：結帳日 15、繳款日 3）', () => {
  it('今天在結帳日前 → 本期迄於本月 15 日', () => {
    const cycle = computeCardCycle(15, 3, parseCivilDate('2026-07-10'));
    expect(formatCivilDate(cycle.periodStart)).toBe('2026-06-16');
    expect(formatCivilDate(cycle.periodEnd)).toBe('2026-07-15');
    expect(formatCivilDate(cycle.dueDate)).toBe('2026-08-03'); // 結帳後第一個 3 號
  });

  it('今天已過結帳日 → 本期迄於下月 15 日', () => {
    const cycle = computeCardCycle(15, 3, parseCivilDate('2026-07-20'));
    expect(formatCivilDate(cycle.periodStart)).toBe('2026-07-16');
    expect(formatCivilDate(cycle.periodEnd)).toBe('2026-08-15');
    expect(formatCivilDate(cycle.dueDate)).toBe('2026-09-03');
  });

  it('結帳日=今天 → 今天仍屬本期', () => {
    const cycle = computeCardCycle(15, 3, parseCivilDate('2026-07-15'));
    expect(formatCivilDate(cycle.periodEnd)).toBe('2026-07-15');
  });

  it('月底結帳日（31）：小月自動取月底（F3 邊角）', () => {
    const cycle = computeCardCycle(31, 15, parseCivilDate('2026-04-10'));
    expect(formatCivilDate(cycle.periodEnd)).toBe('2026-04-30');
    expect(formatCivilDate(cycle.periodStart)).toBe('2026-04-01'); // 3/31 翌日
    expect(formatCivilDate(cycle.dueDate)).toBe('2026-05-15');
  });

  it('繳款日在結帳日同月之後（結帳 5、繳款 20）', () => {
    const cycle = computeCardCycle(5, 20, parseCivilDate('2026-07-03'));
    expect(formatCivilDate(cycle.statementDate)).toBe('2026-07-05');
    expect(formatCivilDate(cycle.dueDate)).toBe('2026-07-20'); // 同月
  });

  it('上一期（已結帳）週期', () => {
    const prev = computePreviousCardCycle(15, 3, parseCivilDate('2026-07-10'));
    expect(formatCivilDate(prev.periodStart)).toBe('2026-05-16');
    expect(formatCivilDate(prev.periodEnd)).toBe('2026-06-15');
    expect(formatCivilDate(prev.dueDate)).toBe('2026-07-03');
  });

  it('無效結帳/繳款日拒絕', () => {
    expect(() => computeCardCycle(0, 3, parseCivilDate('2026-07-10'))).toThrow(DomainError);
    expect(() => computeCardCycle(15, 32, parseCivilDate('2026-07-10'))).toThrow(DomainError);
  });
});
