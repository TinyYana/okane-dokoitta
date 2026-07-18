import { describe, expect, it } from 'vitest';
import {
  allocate,
  amountToDecimalString,
  convert,
  divideRound,
  DomainError,
  money,
  parseAmount,
} from '../src/index.js';

describe('parseAmount（字串→最小單位，不經浮點）', () => {
  it('TWD 指數 0：整數元', () => {
    expect(parseAmount('185', 'TWD')).toBe(185n);
    expect(parseAmount('0', 'TWD')).toBe(0n);
    expect(parseAmount('-45', 'TWD')).toBe(-45n);
  });

  it('USD 指數 2：兩位小數', () => {
    expect(parseAmount('1.85', 'USD')).toBe(185n);
    expect(parseAmount('1.8', 'USD')).toBe(180n);
    expect(parseAmount('1', 'USD')).toBe(100n);
    expect(parseAmount('-3.50', 'USD')).toBe(-350n);
  });

  it('TWD 大額 > 2^31（bigint 路徑）', () => {
    expect(parseAmount('3000000000', 'TWD')).toBe(3000000000n);
    expect(parseAmount('9007199254740993', 'TWD')).toBe(9007199254740993n); // > Number.MAX_SAFE_INTEGER
  });

  it('小數位超過幣別指數 → 拒絕', () => {
    expect(() => parseAmount('1.5', 'TWD')).toThrow(DomainError);
    expect(() => parseAmount('1.855', 'USD')).toThrow(DomainError);
  });

  it('垃圾輸入 → 拒絕', () => {
    for (const bad of ['', 'abc', '1,000', '1e5', 'NaN', 'Infinity', '0x10', '1.']) {
      expect(() => parseAmount(bad, 'TWD'), bad).toThrow(DomainError);
    }
  });

  it('未知幣別 → 拒絕', () => {
    expect(() => parseAmount('1', 'XXX')).toThrow(DomainError);
  });
});

describe('amountToDecimalString（最小單位→十進位字串）', () => {
  it('往返一致', () => {
    expect(amountToDecimalString(185n, 'TWD')).toBe('185');
    expect(amountToDecimalString(185n, 'USD')).toBe('1.85');
    expect(amountToDecimalString(5n, 'USD')).toBe('0.05');
    expect(amountToDecimalString(-350n, 'USD')).toBe('-3.50');
    expect(amountToDecimalString(0n, 'USD')).toBe('0.00');
    expect(amountToDecimalString(9007199254740993n, 'TWD')).toBe('9007199254740993');
  });
});

describe('divideRound（唯一除法出口：round half away from zero）', () => {
  it('四捨五入', () => {
    expect(divideRound(10n, 3n)).toBe(3n); // 3.33 → 3
    expect(divideRound(10n, 4n)).toBe(3n); // 2.5 → 3
    expect(divideRound(11n, 4n)).toBe(3n); // 2.75 → 3
    expect(divideRound(9n, 4n)).toBe(2n); // 2.25 → 2
  });

  it('負數對稱（away from zero）', () => {
    expect(divideRound(-10n, 4n)).toBe(-3n); // −2.5 → −3
    expect(divideRound(10n, -4n)).toBe(-3n);
    expect(divideRound(-10n, -4n)).toBe(3n);
  });

  it('除以零 → 拒絕', () => {
    expect(() => divideRound(1n, 0n)).toThrow(DomainError);
  });
});

describe('allocate（分期分攤：總和恰等於原額）', () => {
  it('整除', () => {
    expect(allocate(300n, 3)).toEqual([100n, 100n, 100n]);
  });

  it('不整除：前面多 1，總和不變', () => {
    expect(allocate(100n, 3)).toEqual([34n, 33n, 33n]);
    expect(allocate(100n, 3).reduce((a, b) => a + b, 0n)).toBe(100n);
  });

  it('負數金額', () => {
    expect(allocate(-100n, 3)).toEqual([-34n, -33n, -33n]);
    expect(allocate(-100n, 3).reduce((a, b) => a + b, 0n)).toBe(-100n);
  });

  it('極值：0、1、大額', () => {
    expect(allocate(0n, 5)).toEqual([0n, 0n, 0n, 0n, 0n]);
    expect(allocate(1n, 3)).toEqual([1n, 0n, 0n]);
    const parts = allocate(9007199254740993n, 7);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(9007199254740993n);
  });

  it('份數必須是正整數', () => {
    expect(() => allocate(100n, 0)).toThrow(DomainError);
    expect(() => allocate(100n, -1)).toThrow(DomainError);
    expect(() => allocate(100n, 1.5)).toThrow(DomainError);
  });
});

describe('convert（匯率換算：全程 bigint，集中捨入）', () => {
  it('USD → TWD（1 USD = 32.045 TWD）', () => {
    // 100.00 USD × 32.045 = 3204.5 TWD → 3205（half away from zero）
    expect(convert(money(10000n, 'USD'), 'TWD', '32.045')).toEqual({ amountMinor: 3205n, currency: 'TWD' });
  });

  it('TWD → USD（指數 0 → 2）', () => {
    // 1000 TWD × 0.0312 = 31.2 USD → 3120 cents
    expect(convert(money(1000n, 'TWD'), 'USD', '0.0312')).toEqual({ amountMinor: 3120n, currency: 'USD' });
  });

  it('JPY → TWD（兩個指數 0 幣別）', () => {
    // 1000 JPY × 0.218 = 218 TWD
    expect(convert(money(1000n, 'JPY'), 'TWD', '0.218')).toEqual({ amountMinor: 218n, currency: 'TWD' });
  });

  it('負數金額（退款方向）', () => {
    expect(convert(money(-10000n, 'USD'), 'TWD', '32.045')).toEqual({ amountMinor: -3205n, currency: 'TWD' });
  });

  it('匯率 0 或格式錯誤 → 拒絕', () => {
    expect(() => convert(money(100n, 'USD'), 'TWD', '0')).toThrow(DomainError);
    expect(() => convert(money(100n, 'USD'), 'TWD', 'abc')).toThrow(DomainError);
    expect(() => convert(money(100n, 'USD'), 'TWD', '-1')).toThrow(DomainError);
  });
});
