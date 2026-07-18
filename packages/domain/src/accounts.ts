import { DomainError } from './errors.js';

/** DATA_MODEL §3.1：一切皆帳戶——資產、負債、分類（income/expense 帳戶）、equity。 */
export const ACCOUNT_KINDS = ['asset', 'liability', 'income', 'expense', 'equity'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const ACCOUNT_SUBTYPES = [
  'cash',
  'bank',
  'digital',
  'e_wallet',
  'credit_card',
  'brokerage_settlement',
  'investment_asset',
  'other_asset',
  'other_liability',
  'category_income',
  'category_expense',
  'opening_balance',
] as const;
export type AccountSubtype = (typeof ACCOUNT_SUBTYPES)[number];

export const DEFAULT_EXPENSE_CATEGORIES = [
  '外食',
  '生鮮雜貨',
  '交通',
  '居住',
  '水電瓦斯',
  '通訊網路',
  '日用品',
  '醫療保健',
  '保險',
  '教育學習',
  '娛樂',
  '訂閱',
  '旅遊',
  '服飾美容',
  '寵物',
  '稅費與手續費',
  '海外交易手續費',
  '人情與捐贈',
  '其他支出',
] as const;

// 信用卡回饋（Q17 作者拍板）：現金折抵入帳記獨立收入分類，不高估消費也不污染退款語意
export const DEFAULT_INCOME_CATEGORIES = ['薪資', '獎金', '接案', '利息', '股息', '租金', '信用卡回饋', '其他收入'] as const;

/** subtype → 唯一合法 kind */
export const SUBTYPE_KIND: Record<AccountSubtype, AccountKind> = {
  cash: 'asset',
  bank: 'asset',
  digital: 'asset',
  e_wallet: 'asset',
  credit_card: 'liability',
  brokerage_settlement: 'asset',
  investment_asset: 'asset',
  other_asset: 'asset',
  other_liability: 'liability',
  category_income: 'income',
  category_expense: 'expense',
  opening_balance: 'equity',
};

/** domain 驗證所需的帳戶最小資訊（repository 提供）。 */
export interface AccountInfo {
  id: string;
  kind: AccountKind;
  subtype: AccountSubtype;
  currency: string;
  deletedAt: string | null;
  archivedAt: string | null;
}

export function assertKindMatchesSubtype(kind: AccountKind, subtype: AccountSubtype): void {
  if (SUBTYPE_KIND[subtype] !== kind) {
    throw new DomainError('ACCOUNT_KIND_INVALID', `subtype ${subtype} 的 kind 必須是 ${SUBTYPE_KIND[subtype]}，收到 ${kind}`);
  }
}

/** 可作為支出/轉帳資金來源的帳戶（資產或信用卡）。 */
export function isSpendableAccount(account: AccountInfo): boolean {
  return account.kind === 'asset' || account.subtype === 'credit_card';
}

export function assertUsableAccount(account: AccountInfo): void {
  if (account.deletedAt !== null) {
    throw new DomainError('ACCOUNT_DELETED', `帳戶已刪除: ${account.id}`);
  }
  // 封存帳戶：不出現在快速選單，但歷史與寫入照常（DATA_MODEL §3.1）。
}
