import { describe, expect, it } from 'vitest';
import {
  assertEntryInvariants,
  buildPosting,
  type AccountInfo,
  type TransactionInput,
} from '../src/index.js';

// 測試帳戶組（去識別化假資料）
const A = {
  bank: acc('bank-1', 'asset', 'bank', 'TWD'),
  bankUsd: acc('bank-usd', 'asset', 'bank', 'USD'),
  cash: acc('cash-1', 'asset', 'cash', 'TWD'),
  card: acc('card-1', 'liability', 'credit_card', 'TWD'),
  food: acc('cat-food', 'expense', 'category_expense', 'TWD'),
  salary: acc('cat-salary', 'income', 'category_income', 'TWD'),
  dividendCat: acc('cat-dividend', 'income', 'category_income', 'TWD'),
  pnl: acc('cat-pnl', 'income', 'category_income', 'TWD'),
  settlement: acc('settle-1', 'asset', 'brokerage_settlement', 'TWD'),
  invest: acc('invest-1', 'asset', 'investment_asset', 'TWD'),
  opening: acc('equity-open', 'equity', 'opening_balance', 'TWD'),
  otherLiability: acc('loan-1', 'liability', 'other_liability', 'TWD'),
  deleted: { ...acc('gone-1', 'asset', 'bank', 'TWD'), deletedAt: '2026-01-01T00:00:00Z' },
};

const accounts = new Map(Object.values(A).map((a) => [a.id, a]));

function acc(id: string, kind: AccountInfo['kind'], subtype: AccountInfo['subtype'], currency: string): AccountInfo {
  return { id, kind, subtype, currency, deletedAt: null, archivedAt: null };
}

function txn(partial: Partial<TransactionInput> & Pick<TransactionInput, 'type'>): TransactionInput {
  return {
    id: 'txn-1',
    status: 'posted',
    amountMinor: 185n,
    currency: 'TWD',
    occurredAt: '2026-07-17T04:00:00Z',
    source: 'manual',
    ...partial,
  };
}

function lineFor(result: ReturnType<typeof buildPosting>, accountId: string) {
  return result.entry.lines.find((l) => l.accountId === accountId);
}

describe('posting rules：每種交易類型 → 預期 lines（符號規約：借正貸負）', () => {
  it('現金/銀行支出 185：分類 +185、銀行 −185', () => {
    const r = buildPosting(txn({ type: 'expense', fromAccountId: A.bank.id, categoryAccountId: A.food.id }), accounts);
    expect(r.entry.lines).toHaveLength(2);
    expect(lineFor(r, A.food.id)?.amountMinor).toBe(185n);
    expect(lineFor(r, A.bank.id)?.amountMinor).toBe(-185n);
  });

  it('信用卡消費 185：分類 +185、卡負債 −185（負債增加記負）', () => {
    const r = buildPosting(txn({ type: 'expense', fromAccountId: A.card.id, categoryAccountId: A.food.id }), accounts);
    expect(lineFor(r, A.food.id)?.amountMinor).toBe(185n);
    expect(lineFor(r, A.card.id)?.amountMinor).toBe(-185n);
  });

  it('收入：銀行 +n、收入分類 −n', () => {
    const r = buildPosting(txn({ type: 'income', amountMinor: 50000n, toAccountId: A.bank.id, categoryAccountId: A.salary.id }), accounts);
    expect(lineFor(r, A.bank.id)?.amountMinor).toBe(50000n);
    expect(lineFor(r, A.salary.id)?.amountMinor).toBe(-50000n);
  });

  it('信用卡現金回饋：卡負債減少 +n、收入分類 −n', () => {
    const r = buildPosting(txn({ type: 'income', amountMinor: 120n, toAccountId: A.card.id, categoryAccountId: A.salary.id }), accounts);
    expect(lineFor(r, A.card.id)?.amountMinor).toBe(120n);
    expect(lineFor(r, A.salary.id)?.amountMinor).toBe(-120n);
  });

  it('帳戶間轉帳（TXN-5）：單一交易兩條 lines', () => {
    const r = buildPosting(txn({ type: 'transfer', amountMinor: 1000n, fromAccountId: A.bank.id, toAccountId: A.cash.id }), accounts);
    expect(r.entry.lines).toHaveLength(2);
    expect(lineFor(r, A.cash.id)?.amountMinor).toBe(1000n);
    expect(lineFor(r, A.bank.id)?.amountMinor).toBe(-1000n);
  });

  it('【硬規則】信用卡繳款是轉帳：卡 +n（負債↓）、銀行 −n，不產生任何 expense line', () => {
    const r = buildPosting(txn({ type: 'card_payment', amountMinor: 6842n, fromAccountId: A.bank.id, toAccountId: A.card.id }), accounts);
    expect(r.entry.lines).toHaveLength(2);
    expect(lineFor(r, A.card.id)?.amountMinor).toBe(6842n);
    expect(lineFor(r, A.bank.id)?.amountMinor).toBe(-6842n);
    // 不含任何 expense 分類帳戶的 line
    const expenseLines = r.entry.lines.filter((l) => accounts.get(l.accountId)?.kind === 'expense');
    expect(expenseLines).toHaveLength(0);
  });

  it('【硬規則】投資買入是資產轉換：投資資產 +n、交割 −n，不產生 expense line', () => {
    const r = buildPosting(txn({ type: 'invest_buy', amountMinor: 5000n, fromAccountId: A.settlement.id, toAccountId: A.invest.id }), accounts);
    expect(r.entry.lines).toHaveLength(2);
    expect(lineFor(r, A.invest.id)?.amountMinor).toBe(5000n);
    expect(lineFor(r, A.settlement.id)?.amountMinor).toBe(-5000n);
    const expenseLines = r.entry.lines.filter((l) => accounts.get(l.accountId)?.kind === 'expense');
    expect(expenseLines).toHaveLength(0);
  });

  it('投資賣出（有獲利）：交割 +賣額、投資資產 −成本、損益分類收差額；賣出不是一般收入', () => {
    const r = buildPosting(
      txn({ type: 'invest_sell', amountMinor: 5500n, costBasisMinor: 5000n, fromAccountId: A.invest.id, toAccountId: A.settlement.id, categoryAccountId: A.pnl.id }),
      accounts,
    );
    expect(lineFor(r, A.settlement.id)?.amountMinor).toBe(5500n);
    expect(lineFor(r, A.invest.id)?.amountMinor).toBe(-5000n);
    expect(lineFor(r, A.pnl.id)?.amountMinor).toBe(-500n); // 獲利：收入增加記負
  });

  it('投資賣出（虧損）：損益分類記正（Q11：正負皆同一分類）', () => {
    const r = buildPosting(
      txn({ type: 'invest_sell', amountMinor: 4000n, costBasisMinor: 5000n, fromAccountId: A.invest.id, toAccountId: A.settlement.id, categoryAccountId: A.pnl.id }),
      accounts,
    );
    expect(lineFor(r, A.pnl.id)?.amountMinor).toBe(1000n);
  });

  it('股息：交割 +n、股息收入分類 −n', () => {
    const r = buildPosting(txn({ type: 'dividend', amountMinor: 320n, toAccountId: A.settlement.id, categoryAccountId: A.dividendCat.id }), accounts);
    expect(lineFor(r, A.settlement.id)?.amountMinor).toBe(320n);
    expect(lineFor(r, A.dividendCat.id)?.amountMinor).toBe(-320n);
  });

  it('手續費：expense 形狀（分類 +n、資產 −n）', () => {
    const r = buildPosting(txn({ type: 'fee', amountMinor: 20n, fromAccountId: A.settlement.id, categoryAccountId: A.food.id }), accounts);
    expect(lineFor(r, A.food.id)?.amountMinor).toBe(20n);
    expect(lineFor(r, A.settlement.id)?.amountMinor).toBe(-20n);
  });

  it('期初餘額（adjustment）：帳戶 +n、opening_balance equity −n；餘額不是可編輯欄位', () => {
    const r = buildPosting(txn({ type: 'adjustment', amountMinor: 100000n, fromAccountId: A.opening.id, toAccountId: A.bank.id }), accounts);
    expect(lineFor(r, A.bank.id)?.amountMinor).toBe(100000n);
    expect(lineFor(r, A.opening.id)?.amountMinor).toBe(-100000n);
  });

  it('還款到其他負債：transfer 允許 asset → other_liability', () => {
    const r = buildPosting(txn({ type: 'transfer', amountMinor: 3000n, fromAccountId: A.bank.id, toAccountId: A.otherLiability.id }), accounts);
    expect(lineFor(r, A.otherLiability.id)?.amountMinor).toBe(3000n);
  });
});

describe('退款（硬規則：必須連結原交易）', () => {
  it('退款：原分錄反向 + refund link', () => {
    const r = buildPosting(
      txn({ type: 'refund', id: 'txn-refund', amountMinor: 185n, toAccountId: A.card.id, categoryAccountId: A.food.id, originalTransactionId: 'txn-orig' }),
      accounts,
    );
    expect(lineFor(r, A.card.id)?.amountMinor).toBe(185n); // 卡負債減少
    expect(lineFor(r, A.food.id)?.amountMinor).toBe(-185n); // 費用沖回
    expect(r.links).toEqual([{ kind: 'refund', fromTransactionId: 'txn-orig', toTransactionId: 'txn-refund' }]);
  });

  it('【硬規則】退款缺 originalTransactionId → 拒絕', () => {
    expect(() =>
      buildPosting(txn({ type: 'refund', toAccountId: A.bank.id, categoryAccountId: A.food.id }), accounts),
    ).toThrowError(expect.objectContaining({ code: 'REFUND_MISSING_LINK' }));
  });
});

describe('不變量與驗證拒絕案例', () => {
  it('I-1：少於 2 條 lines 拒絕', () => {
    expect(() =>
      assertEntryInvariants({ entryDate: '2026-07-17', description: 'x', lines: [{ accountId: 'a', amountMinor: 1n, currency: 'TWD' }] }),
    ).toThrowError(expect.objectContaining({ code: 'ENTRY_TOO_FEW_LINES' }));
  });

  it('I-2：每幣別總和 ≠ 0 拒絕', () => {
    expect(() =>
      assertEntryInvariants({
        entryDate: '2026-07-17',
        description: 'x',
        lines: [
          { accountId: 'a', amountMinor: 100n, currency: 'TWD' },
          { accountId: 'b', amountMinor: -99n, currency: 'TWD' },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'ENTRY_UNBALANCED' }));
  });

  it('I-2：兩幣別各自平衡才通過；單邊跨幣別「看似平衡」要拒絕', () => {
    expect(() =>
      assertEntryInvariants({
        entryDate: '2026-07-17',
        description: 'x',
        lines: [
          { accountId: 'a', amountMinor: 100n, currency: 'USD' },
          { accountId: 'b', amountMinor: -100n, currency: 'TWD' },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'ENTRY_UNBALANCED' }));
    // 合法：每幣別各自歸零
    assertEntryInvariants({
      entryDate: '2026-07-17',
      description: 'x',
      lines: [
        { accountId: 'a', amountMinor: 100n, currency: 'USD' },
        { accountId: 'b', amountMinor: -100n, currency: 'USD' },
        { accountId: 'c', amountMinor: 3200n, currency: 'TWD' },
        { accountId: 'd', amountMinor: -3200n, currency: 'TWD' },
      ],
    });
  });

  it('金額 0 或負 → 拒絕', () => {
    expect(() =>
      buildPosting(txn({ type: 'expense', amountMinor: 0n, fromAccountId: A.bank.id, categoryAccountId: A.food.id }), accounts),
    ).toThrowError(expect.objectContaining({ code: 'AMOUNT_NOT_POSITIVE' }));
    expect(() =>
      buildPosting(txn({ type: 'expense', amountMinor: -5n, fromAccountId: A.bank.id, categoryAccountId: A.food.id }), accounts),
    ).toThrowError(expect.objectContaining({ code: 'AMOUNT_NOT_POSITIVE' }));
  });

  it('帳戶 kind 不符 → 拒絕（收入分類拿去記支出）', () => {
    expect(() =>
      buildPosting(txn({ type: 'expense', fromAccountId: A.bank.id, categoryAccountId: A.salary.id }), accounts),
    ).toThrowError(expect.objectContaining({ code: 'ACCOUNT_KIND_INVALID' }));
  });

  it('轉入信用卡的 transfer → 拒絕（必須用 card_payment）', () => {
    expect(() =>
      buildPosting(txn({ type: 'transfer', fromAccountId: A.bank.id, toAccountId: A.card.id }), accounts),
    ).toThrowError(expect.objectContaining({ code: 'TRANSACTION_TYPE_INVALID' }));
  });

  it('card_payment 的 to 不是信用卡 → 拒絕', () => {
    expect(() =>
      buildPosting(txn({ type: 'card_payment', fromAccountId: A.bank.id, toAccountId: A.cash.id }), accounts),
    ).toThrowError(expect.objectContaining({ code: 'ACCOUNT_KIND_INVALID' }));
  });

  it('收入不能記到一般負債', () => {
    expect(() =>
      buildPosting(txn({ type: 'income', toAccountId: A.otherLiability.id, categoryAccountId: A.salary.id }), accounts),
    ).toThrowError(expect.objectContaining({ code: 'ACCOUNT_KIND_INVALID' }));
  });

  it('幣別不一致 → 拒絕（TWD 交易打到 USD 帳戶）', () => {
    expect(() =>
      buildPosting(txn({ type: 'expense', fromAccountId: A.bankUsd.id, categoryAccountId: A.food.id }), accounts),
    ).toThrowError(expect.objectContaining({ code: 'CURRENCY_MISMATCH' }));
  });

  it('已刪除帳戶 → 拒絕', () => {
    expect(() =>
      buildPosting(txn({ type: 'expense', fromAccountId: A.deleted.id, categoryAccountId: A.food.id }), accounts),
    ).toThrowError(expect.objectContaining({ code: 'ACCOUNT_DELETED' }));
  });

  it('大額 bigint（> 2^31）路徑', () => {
    const r = buildPosting(txn({ type: 'transfer', amountMinor: 3000000000n, fromAccountId: A.bank.id, toAccountId: A.cash.id }), accounts);
    expect(lineFor(r, A.cash.id)?.amountMinor).toBe(3000000000n);
  });
});

describe('entry date：occurred_at（UTC）→ 帳本時區民用日期', () => {
  it('台北 23:50 的消費落在當天（UTC 已是隔天前一日 15:50）', () => {
    // 2026-07-17 23:50 台北 = 2026-07-17T15:50:00Z
    const r = buildPosting(
      txn({ type: 'expense', occurredAt: '2026-07-17T15:50:00Z', fromAccountId: A.bank.id, categoryAccountId: A.food.id }),
      accounts,
    );
    expect(r.entry.entryDate).toBe('2026-07-17');
  });

  it('台北 00:10 的消費落在當天（UTC 是前一天 16:10）', () => {
    // 2026-07-18 00:10 台北 = 2026-07-17T16:10:00Z
    const r = buildPosting(
      txn({ type: 'expense', occurredAt: '2026-07-17T16:10:00Z', fromAccountId: A.bank.id, categoryAccountId: A.food.id }),
      accounts,
    );
    expect(r.entry.entryDate).toBe('2026-07-18');
  });
});
