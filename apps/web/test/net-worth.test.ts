import { describe, expect, it } from 'vitest';
import { netWorthBubbleSources, netWorthEquation } from '../src/net-worth.js';

describe('淨資產首頁拆解', () => {
  it('保留負資產帳戶扣除項，總式可以驗算中央淨資產', () => {
    const sources = [
      { accountId: 'cash', name: '銀行', institution: null, kind: 'cash' as const, amountMinor: '110337' },
      { accountId: 'settlement', name: '證券交割', institution: null, kind: 'cash' as const, amountMinor: '-59610' },
    ];
    expect(netWorthEquation(sources)).toEqual({ assetsMinor: 110337n, deductionsMinor: 59610n });
    expect(netWorthBubbleSources(sources, 5)).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'settlement', contributionMinor: '-59610', deduction: true }),
    ]));
  });

  it('負債的 API 金額即使是正數，對淨資產仍是負貢獻', () => {
    const sources = [{ accountId: 'card', name: '信用卡', institution: null, kind: 'liability' as const, amountMinor: '1200' }];
    expect(netWorthEquation(sources)).toEqual({ assetsMinor: 0n, deductionsMinor: 1200n });
  });
});
