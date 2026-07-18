import { describe, expect, it } from 'vitest';
import { validateAssignStatementPatch } from '../src/audit-patches.js';

const valid = {
  transaction: { statementId: null, currency: 'TWD', deleted: false },
  statement: { id: 'statement', currency: 'TWD', status: 'closed' as const },
  item: { matchedTransactionId: null, currency: 'TWD' },
  transactionId: 'transaction',
};

describe('assign statement proposed patch', () => {
  it('accepts an unassigned same-currency target', () => {
    expect(() => validateAssignStatementPatch(valid)).not.toThrow();
  });

  it.each([
    [{ ...valid, transaction: { ...valid.transaction, deleted: true } }, 'PATCH_TARGET_DELETED'],
    [{ ...valid, statement: { ...valid.statement, status: 'superseded' as const } }, 'PATCH_STATEMENT_SUPERSEDED'],
    [{ ...valid, item: { ...valid.item, currency: 'JPY' } }, 'CURRENCY_MISMATCH'],
    [{ ...valid, transaction: { ...valid.transaction, statementId: 'other' } }, 'PATCH_ALREADY_ASSIGNED'],
    [{ ...valid, item: { ...valid.item, matchedTransactionId: 'other' } }, 'PATCH_ITEM_ALREADY_MATCHED'],
  ])('rejects invalid patch facts', (facts, code) => {
    expect(() => validateAssignStatementPatch(facts)).toThrow(expect.objectContaining({ code }));
  });
});
