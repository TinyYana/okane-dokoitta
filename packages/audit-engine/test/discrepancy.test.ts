import { describe, expect, it } from 'vitest';
import { buildAuditReportStats, solveDiscrepancy } from '../src/index.js';

describe('差額求解（AUDIT_ENGINE §6）', () => {
  it('依序找單筆、常見錯誤、兩筆、三筆', () => {
    expect(solveDiscrepancy(1205n, [{ id: 'one', amountMinor: 1205n }]).hypotheses[0]?.kind).toBe('single_missing');
    expect(solveDiscrepancy(900n, [{ id: 'tenfold', amountMinor: 1000n, ledgerAmountMinor: 100n, role: 'matched' }]).hypotheses[0]?.kind).toBe('tenfold_error');
    expect(solveDiscrepancy(1000n, [{ id: 'a', amountMinor: 400n }, { id: 'b', amountMinor: 600n }]).hypotheses[0]?.kind).toBe('two_sum');
    expect(solveDiscrepancy(1000n, [{ id: 'a', amountMinor: 200n }, { id: 'b', amountMinor: 300n }, { id: 'c', amountMinor: 500n }]).hypotheses[0]?.kind).toBe('three_sum');
  });

  it('常見錯誤型逐項可解釋且不混入組合搜尋', () => {
    const common = [
      [200n, { id: 'sign', amountMinor: 100n, ledgerAmountMinor: -100n, role: 'matched' as const }, 'sign_flipped'],
      [9900n, { id: 'decimal', amountMinor: 10000n, ledgerAmountMinor: 100n, role: 'matched' as const }, 'currency_or_decimal_error'],
      [50n, { id: 'currency', amountMinor: 100n, ledgerAmountMinor: 50n, currency: 'TWD', ledgerCurrency: 'USD', role: 'matched' as const }, 'currency_or_decimal_error'],
      [-500n, { id: 'payment', amountMinor: 500n, role: 'payment_as_expense' as const }, 'payment_as_expense'],
      [-200n, { id: 'refund', amountMinor: -200n, role: 'refund_unoffset' as const }, 'refund_unoffset'],
      [300n, { id: 'transfer', amountMinor: 300n, role: 'transfer_missing_side' as const }, 'transfer_missing_side'],
      [-400n, { id: 'boundary', amountMinor: 400n, role: 'period_boundary' as const }, 'period_boundary'],
    ] as const;
    for (const [difference, candidate, kind] of common) {
      expect(solveDiscrepancy(difference, [candidate]).hypotheses[0]?.kind).toBe(kind);
    }
  });

  it('無法解釋時誠實保留未解差額', () => {
    const result = solveDiscrepancy(99n, [{ id: 'one', amountMinor: 10n }]);
    expect(result.hypotheses).toEqual([]);
    expect(result.unresolvedMinor).toBe(99n);
    expect(result.timedOut).toBe(false);
  });

  it('拒絕超過 300 筆；300 筆仍可在上限內找到三筆', () => {
    expect(() => solveDiscrepancy(1n, Array.from({ length: 301 }, (_, index) => ({ id: String(index), amountMinor: 1000n + BigInt(index) })))).toThrow(/300/);
    const candidates = Array.from({ length: 300 }, (_, index) => ({ id: String(index), amountMinor: 1000n + BigInt(index) }));
    candidates[297] = { id: 'x', amountMinor: 10n };
    candidates[298] = { id: 'y', amountMinor: 20n };
    candidates[299] = { id: 'z', amountMinor: 30n };
    const startedAt = Date.now();
    const result = solveDiscrepancy(60n, candidates);
    expect(result.hypotheses.some((hypothesis) => hypothesis.kind === 'three_sum')).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('大量重複金額造成組合爆量時也會在 timeout 內中止', () => {
    const candidates = Array.from({ length: 300 }, (_, index) => ({ id: String(index), amountMinor: 1n }));
    const startedAt = Date.now();
    const result = solveDiscrepancy(3n, candidates, 20);
    expect(result.timedOut).toBe(true);
    expect(result.hypotheses).toEqual([]);
    expect(result.unresolvedMinor).toBe(3n);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});

describe('審計報告統計', () => {
  it('分開高低可信與差異類型，並回報修正後是否平衡', () => {
    const stats = buildAuditReportStats({
      statementTotalMinor: 23_456n,
      ledgerExpectedMinor: 22_251n,
      correctedDifferenceMinor: 0n,
      candidates: [
        { kind: 'match', score: 0.95 },
        { kind: 'match', score: 0.7 },
        { kind: 'missing_in_ledger' },
      ],
    });
    expect(stats.differenceMinor).toBe(1205n);
    expect(stats).toMatchObject({ automaticMatches: 2, highConfidence: 1, lowConfidence: 1, correctedBalanced: true });
    expect(stats.byKind.missing_in_ledger).toBe(1);
  });
});
