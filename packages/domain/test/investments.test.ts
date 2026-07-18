import { describe, expect, it } from 'vitest';
import { applyBuy, applySell, computeMarketValueMinor, formatQuantity, parseQuantity } from '../src/index.js';

describe('parseQuantity / formatQuantity：6 位小數 micro units', () => {
  it('整股與零股都能來回轉換', () => {
    expect(parseQuantity('100')).toBe(100_000_000n);
    expect(formatQuantity(100_000_000n)).toBe('100');
    expect(parseQuantity('12.5')).toBe(12_500_000n);
    expect(formatQuantity(12_500_000n)).toBe('12.5');
  });

  it('超過 6 位小數或非正數 → 拒絕', () => {
    expect(() => parseQuantity('1.1234567')).toThrowError(expect.objectContaining({ code: 'AMOUNT_INVALID' }));
    expect(() => parseQuantity('0')).toThrowError(expect.objectContaining({ code: 'AMOUNT_NOT_POSITIVE' }));
  });
});

describe('平均成本法（INVESTMENT_MODEL §3）', () => {
  it('買入：加量加成本；分批買入平均攤提', () => {
    const first = applyBuy(undefined, parseQuantity('100'), 5000n);
    expect(first).toEqual({ quantityMicro: 100_000_000n, costBasisMinor: 5000n });
    const second = applyBuy(first, parseQuantity('50'), 3000n);
    expect(second).toEqual({ quantityMicro: 150_000_000n, costBasisMinor: 8000n });
  });

  it('賣出：依比例攤提成本，賣一半消耗一半成本', () => {
    const holding = { quantityMicro: parseQuantity('100'), costBasisMinor: 5000n };
    const { next, costBasisMinor } = applySell(holding, parseQuantity('50'));
    expect(costBasisMinor).toBe(2500n);
    expect(next).toEqual({ quantityMicro: parseQuantity('50'), costBasisMinor: 2500n });
  });

  it('賣出超過持倉 → 拒絕', () => {
    const holding = { quantityMicro: parseQuantity('10'), costBasisMinor: 1000n };
    expect(() => applySell(holding, parseQuantity('11'))).toThrowError(
      expect.objectContaining({ code: 'HOLDING_INSUFFICIENT' }),
    );
    expect(() => applySell(undefined, parseQuantity('1'))).toThrowError(
      expect.objectContaining({ code: 'HOLDING_INSUFFICIENT' }),
    );
  });
});

describe('市值換算（INVESTMENT_MODEL §4）', () => {
  it('quantity × price，捨入到幣別最小單位', () => {
    // 100 股 × 123.45 USD = 12345.00 USD → 1234500 分
    expect(computeMarketValueMinor(parseQuantity('100'), '123.45', 'USD')).toBe(1_234_500n);
    // TWD 無小數：10 股 × 33.333 → 333.33 四捨五入 333
    expect(computeMarketValueMinor(parseQuantity('10'), '33.333', 'TWD')).toBe(333n);
  });
});
