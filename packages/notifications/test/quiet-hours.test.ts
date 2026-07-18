import { describe, expect, it } from 'vitest';
import { isQuietHours, minuteOfDayInTimeZone } from '../src/quiet-hours.js';

describe('isQuietHours', () => {
  it('未設定（null）永遠不是 quiet hours', () => {
    expect(isQuietHours(0, null, null)).toBe(false);
    expect(isQuietHours(720, 60, null)).toBe(false);
  });

  it('一般區間（不跨午夜）', () => {
    expect(isQuietHours(10 * 60, 9 * 60, 18 * 60)).toBe(true);
    expect(isQuietHours(8 * 60, 9 * 60, 18 * 60)).toBe(false);
    expect(isQuietHours(18 * 60, 9 * 60, 18 * 60)).toBe(false); // 結束分鐘不含
  });

  it('跨午夜區間（22:00–07:00）', () => {
    expect(isQuietHours(23 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(isQuietHours(6 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(isQuietHours(12 * 60, 22 * 60, 7 * 60)).toBe(false);
  });

  it('起訖相同視為未啟用', () => {
    expect(isQuietHours(100, 60, 60)).toBe(false);
  });
});

describe('minuteOfDayInTimeZone', () => {
  it('換算 UTC 到 Asia/Taipei（+8）', () => {
    const instant = new Date('2026-07-18T01:30:00.000Z'); // UTC 01:30 → 台北 09:30
    expect(minuteOfDayInTimeZone(instant, 'Asia/Taipei')).toBe(9 * 60 + 30);
  });

  it('跨日換算（UTC 23:00 → 台北隔天 07:00）', () => {
    const instant = new Date('2026-07-18T23:00:00.000Z');
    expect(minuteOfDayInTimeZone(instant, 'Asia/Taipei')).toBe(7 * 60);
  });
});
