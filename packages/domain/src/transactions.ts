import { DomainError } from './errors.js';

export const TRANSACTION_TYPES = [
  'expense',
  'income',
  'transfer',
  'card_payment',
  'refund',
  'invest_buy',
  'invest_sell',
  'dividend',
  'fee',
  'tax',
  'adjustment',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_STATUSES = [
  'draft',
  'expected',
  'pending',
  'posted',
  'cancelled',
  'disputed',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/**
 * 狀態機（DATA_MODEL §3.6）：
 *   draft ──► pending ──► posted ──► (cancelled | disputed)
 *   expected ─► pending
 *   draft/expected/pending 皆可 → cancelled
 */
const ALLOWED_TRANSITIONS: Record<TransactionStatus, readonly TransactionStatus[]> = {
  draft: ['pending', 'cancelled'],
  expected: ['pending', 'cancelled'],
  pending: ['posted', 'cancelled'],
  posted: ['cancelled', 'disputed'],
  cancelled: [],
  disputed: [],
};

export function canTransitionStatus(from: TransactionStatus, to: TransactionStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertStatusTransition(from: TransactionStatus, to: TransactionStatus): void {
  if (!canTransitionStatus(from, to)) {
    throw new DomainError('INVALID_STATUS_TRANSITION', `交易狀態不可從 ${from} 轉為 ${to}`);
  }
}

export const TRANSACTION_SOURCES = ['manual', 'import', 'recurring', 'discord_draft', 'patch'] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

export const TRANSACTION_LINK_KINDS = [
  'refund',
  'installment_parent',
  'fx_pair',
  'duplicate_of',
  'payment_for_statement',
  'correction',
] as const;
export type TransactionLinkKind = (typeof TRANSACTION_LINK_KINDS)[number];

/** 建立交易時 domain service 需要的輸入（id 一律 client 產生的 UUIDv7）。 */
export interface TransactionInput {
  id: string;
  type: TransactionType;
  status: TransactionStatus;
  amountMinor: bigint;
  currency: string;
  fromAccountId?: string | undefined;
  toAccountId?: string | undefined;
  categoryAccountId?: string | undefined;
  /** 跨幣別（I-3）：對方幣別金額，同時記錄成交匯率於 fx_pair link */
  counterAmountMinor?: bigint | undefined;
  counterCurrency?: string | undefined;
  /** refund 必填：原始交易 id（硬規則：退款必須連結原交易） */
  originalTransactionId?: string | undefined;
  /** invest_sell 用：賣出部位的成本基礎；與賣出金額的差額記入已實現損益分類 */
  costBasisMinor?: bigint | undefined;
  merchantRaw?: string | undefined;
  note?: string | undefined;
  occurredAt: string; // UTC ISO 8601
  authorizedAt?: string | undefined;
  postedAt?: string | undefined;
  installmentCurrent?: number | undefined;
  installmentTotal?: number | undefined;
  source: TransactionSource;
  /** Discord 草稿（source=discord_draft）等需要使用者在 PWA 二次確認的建立情境用 */
  needsReview?: boolean | undefined;
}
