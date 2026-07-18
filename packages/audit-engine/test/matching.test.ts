import { describe, expect, it } from 'vitest';
import { REASONING_CODES, normalizeMerchant, scorePair } from '../src/index.js';

describe('reasoning code 與 rule-based matching', () => {
  it('理由目錄與 AUDIT_ENGINE §4 一致', () => {
    expect(REASONING_CODES).toHaveLength(24);
    expect(new Set(REASONING_CODES).size).toBe(REASONING_CODES.length);
  });

  it('同額、同日、同商家、同卡 → 高可信且附證據與解釋', () => {
    const result = scorePair(
      { id: 'item', amountMinor: 185n, currency: 'TWD', occurredDate: '2026-07-17', merchantRaw: '全聯 福利中心', cardLast4: '1234' },
      { id: 'txn', amountMinor: 185n, currency: 'TWD', occurredDate: '2026-07-17', merchantNormalized: '全聯福利中心', cardLast4: '1234' },
    );
    expect(result.score).toBeGreaterThanOrEqual(0.9);
    expect(result.reasoningCodes).toEqual(expect.arrayContaining(['AMT_EXACT', 'DATE_SAME', 'MERCHANT_NORMALIZED_EQ', 'CARD_LAST4_MATCH']));
    expect(result.evidence['amountDifferenceMinor']).toBe('0');
    expect(result.explanation).toContain('金額相同');
  });

  it('卡號矛盾會明確扣分，不可成為高可信', () => {
    const result = scorePair(
      { id: 'item', amountMinor: 100n, currency: 'TWD', occurredDate: '2026-07-17', cardLast4: '1234' },
      { id: 'txn', amountMinor: 100n, currency: 'TWD', occurredDate: '2026-07-17', cardLast4: '9999' },
    );
    expect(result.reasoningCodes).toContain('CARD_LAST4_MISMATCH');
    expect(result.score).toBeLessThan(0.9);
  });

  it('任何矛盾訊號都不可被其他加分堆成高可信', () => {
    const result = scorePair(
      { id: 'item', amountMinor: 100n, currency: 'TWD', occurredDate: '2026-07-17', merchantRaw: '甲店' },
      { id: 'txn', amountMinor: 100n, currency: 'TWD', occurredDate: '2026-07-17', merchantRaw: '乙店' },
      { userHistoryMatch: true, balancesStatement: true },
    );
    expect(result.reasoningCodes).toContain('MERCHANT_MISMATCH');
    expect(result.score).toBeLessThan(0.9);
  });

  it('只比較同語意日期，不拿發生日誤比入帳日', () => {
    const result = scorePair(
      { id: 'item', amountMinor: 100n, currency: 'TWD', occurredDate: '2026-07-17' },
      { id: 'txn', amountMinor: 100n, currency: 'TWD', postedDate: '2026-07-17' },
    );
    expect(result.reasoningCodes).not.toEqual(expect.arrayContaining(['DATE_SAME', 'DATE_WITHIN_TOL', 'DATE_FAR']));
  });

  it('商家正規化使用 native Unicode 規則', () => {
    expect(normalizeMerchant(' ＡＢＣ－商店 ')).toBe('abc商店');
  });

  it('金額錯誤型各自留下 reasoning code', () => {
    const base = { id: 'a', currency: 'TWD' };
    expect(scorePair({ ...base, amountMinor: 100n }, { ...base, id: 'b', amountMinor: -100n }).reasoningCodes).toContain('AMT_SIGN_FLIPPED');
    expect(scorePair({ ...base, amountMinor: 1000n }, { ...base, id: 'b', amountMinor: 100n }).reasoningCodes).toContain('AMT_TENFOLD');
    for (const [offset, code] of [[10n, 'AMT_OFFSET_10'], [100n, 'AMT_OFFSET_100'], [1000n, 'AMT_OFFSET_1000']] as const) {
      expect(scorePair({ ...base, amountMinor: 2000n + offset }, { ...base, id: 'b', amountMinor: 2000n }).reasoningCodes).toContain(code);
    }
  });

  it('日期、商家與呼叫端已知訊號都保留具體理由', () => {
    const result = scorePair(
      { id: 'item', amountMinor: -100n, currency: 'USD', postedDate: '2026-07-19', merchantRaw: '原始商店', installment: { current: 2, total: 3 }, type: 'refund' },
      { id: 'txn', amountMinor: 100n, currency: 'TWD', postedDate: '2026-07-17', merchantNormalized: '統一商店', installment: { current: 2, total: 3 }, type: 'purchase' },
      {
        merchantAliases: { [normalizeMerchant('原始商店')]: '統一商店' },
        typicalPostingLagDays: 2,
        fxRateWithinTolerance: true,
        fxRounding: true,
        duplicateSuspect: true,
        userHistoryMatch: true,
        balancesStatement: true,
      },
    );
    expect(result.reasoningCodes).toEqual(expect.arrayContaining([
      'FX_RATE_WITHIN_TOL', 'FX_ROUNDING', 'DATE_WITHIN_TOL', 'POSTING_LAG_TYPICAL', 'MERCHANT_ALIAS',
      'INSTALLMENT_SEQ_MATCH', 'REFUND_PAIR', 'DUPLICATE_SUSPECT', 'USER_HISTORY_MATCH', 'BALANCES_STATEMENT',
    ]));
    expect(result.explanation).toContain('日期差 2 天');
  });

  it('退款理由只用於負額帳單項對正額原交易', () => {
    const item = { id: 'item', amountMinor: -100n, currency: 'TWD', type: 'refund' };
    expect(scorePair(item, { id: 'original', amountMinor: 100n, currency: 'TWD', type: 'purchase' }).reasoningCodes).toContain('REFUND_PAIR');
    expect(scorePair(item, { id: 'refund', amountMinor: -100n, currency: 'TWD', type: 'refund' }).reasoningCodes).not.toContain('REFUND_PAIR');
  });

  it('模糊商家與矛盾訊號分開標示', () => {
    const fuzzy = scorePair(
      { id: 'a', amountMinor: 1n, currency: 'TWD', merchantRaw: '全聯福利中心台北店' },
      { id: 'b', amountMinor: 1n, currency: 'TWD', merchantRaw: '全聯福利中心台中店' },
    );
    expect(fuzzy.reasoningCodes).toContain('MERCHANT_FUZZY');
    const mismatch = scorePair(
      { id: 'a', amountMinor: 1n, currency: 'TWD', occurredDate: '2026-01-01', merchantRaw: '甲店', installment: { current: 1, total: 3 } },
      { id: 'b', amountMinor: 1n, currency: 'TWD', occurredDate: '2026-03-01', merchantRaw: '乙店', installment: { current: 2, total: 3 } },
    );
    expect(mismatch.reasoningCodes).toEqual(expect.arrayContaining(['DATE_FAR', 'MERCHANT_MISMATCH', 'INSTALLMENT_MISMATCH']));
  });
});
