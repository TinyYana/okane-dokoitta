import { parseAmount } from '@okane-dokoitta/domain';
import { IMPORT_LIMITS, ImporterError, type ImportedTransactionType, type StatementDefaults } from './types.js';

export function assertInputSize(text: string): void {
  if (text.length > IMPORT_LIMITS.maxCharacters) {
    throw new ImporterError('INPUT_TOO_LARGE', `輸入超過 ${IMPORT_LIMITS.maxCharacters} 字元上限`);
  }
}

export function amountMinor(input: string, currency: string): bigint {
  const cleaned = input.trim().replaceAll(',', '').replace(/^\((.+)\)$/, '-$1');
  return parseAmount(cleaned, currency);
}

export function normalizedCurrency(value: string | undefined): string {
  const currency = value?.trim().toUpperCase();
  if (!currency) throw new ImporterError('FORMAT_INVALID', '缺少幣別；請在資料列或匯入設定指定');
  return currency;
}

export function validDate(value: string | undefined, field: string): string | undefined {
  const date = value?.trim();
  if (!date) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(date)) {
    throw new ImporterError('FORMAT_INVALID', `${field} 必須是 YYYY-MM-DD 或含時區的 ISO 8601 時間`);
  }
  return date;
}

export function validLast4(value: string | undefined): string | undefined {
  const last4 = value?.trim();
  if (!last4) return undefined;
  if (!/^\d{4}$/.test(last4)) throw new ImporterError('FORMAT_INVALID', '卡號只能提供末四碼');
  return last4;
}

export function parseInstallment(value: string | undefined): { current: number; total: number } | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(text);
  if (!match) throw new ImporterError('FORMAT_INVALID', `分期格式必須是 current/total: ${text}`);
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (current < 1 || total < current) throw new ImporterError('FORMAT_INVALID', `分期期數不合法: ${text}`);
  return { current, total };
}

export function transactionType(value: string | undefined, amount: bigint, hasInstallment: boolean): ImportedTransactionType {
  if (hasInstallment) return 'installment';
  const normalized = value?.trim().toLowerCase();
  const aliases: Record<string, ImportedTransactionType> = {
    purchase: 'purchase',
    refund: 'refund',
    fee: 'fee',
    installment: 'installment',
    payment: 'payment',
    other: 'other',
    消費: 'purchase',
    退款: 'refund',
    手續費: 'fee',
    分期: 'installment',
    繳款: 'payment',
  };
  return (normalized && aliases[normalized]) || (amount < 0n ? 'refund' : 'purchase');
}

export function statementBase(importerId: string, defaults: StatementDefaults | undefined, currency: string) {
  const cardLast4 = validLast4(defaults?.cardLast4);
  const periodStart = validDate(defaults?.periodStart, 'periodStart');
  const periodEnd = validDate(defaults?.periodEnd, 'periodEnd');
  const statementDate = validDate(defaults?.statementDate, 'statementDate');
  const dueDate = validDate(defaults?.dueDate, 'dueDate');
  return {
    importerId,
    currency,
    ...(defaults?.institution ? { institution: defaults.institution } : {}),
    ...(cardLast4 ? { cardLast4 } : {}),
    ...(periodStart ? { periodStart } : {}),
    ...(periodEnd ? { periodEnd } : {}),
    ...(statementDate ? { statementDate } : {}),
    ...(dueDate ? { dueDate } : {}),
    ...(defaults?.total ? { totalMinor: amountMinor(defaults.total, currency) } : {}),
  };
}

/** Apply this when writing user-provided fields to CSV so spreadsheet apps do not execute formulas. */
export function protectSpreadsheetFormula(value: string): string {
  return /^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value;
}
