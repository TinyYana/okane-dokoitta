import { DomainError } from './errors.js';

export interface AssignStatementFacts {
  transaction: { statementId: string | null; currency: string; deleted: boolean };
  statement: { id: string; currency: string; status: 'open' | 'closed' | 'due' | 'paid' | 'superseded' };
  item: { matchedTransactionId: string | null; currency: string };
  transactionId: string;
}

/** proposed patch 寫入前的 domain 驗證；不做 IO，也不替使用者自動決定。 */
export function validateAssignStatementPatch(facts: AssignStatementFacts): void {
  if (facts.transaction.deleted) throw new DomainError('PATCH_TARGET_DELETED', '不能把帳單指派給已刪除交易');
  if (facts.statement.status === 'superseded') throw new DomainError('PATCH_STATEMENT_SUPERSEDED', '不能套用到已被取代的帳單');
  if (facts.transaction.currency !== facts.statement.currency || facts.item.currency !== facts.statement.currency) {
    throw new DomainError('CURRENCY_MISMATCH', '交易、帳單與帳單明細的幣別必須一致');
  }
  if (facts.transaction.statementId && facts.transaction.statementId !== facts.statement.id) {
    throw new DomainError('PATCH_ALREADY_ASSIGNED', '交易已屬於另一張帳單');
  }
  if (facts.item.matchedTransactionId && facts.item.matchedTransactionId !== facts.transactionId) {
    throw new DomainError('PATCH_ITEM_ALREADY_MATCHED', '帳單明細已配對其他交易');
  }
}
