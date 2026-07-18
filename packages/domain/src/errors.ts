export type DomainErrorCode =
  | 'AMOUNT_NOT_POSITIVE'
  | 'AMOUNT_INVALID'
  | 'CURRENCY_UNKNOWN'
  | 'CURRENCY_MISMATCH'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_DELETED'
  | 'ACCOUNT_KIND_INVALID'
  | 'REFUND_MISSING_LINK'
  | 'REFUND_ORIGINAL_INVALID'
  | 'ENTRY_UNBALANCED'
  | 'ENTRY_TOO_FEW_LINES'
  | 'FX_COUNTER_AMOUNT_REQUIRED'
  | 'INVALID_STATUS_TRANSITION'
  | 'DATE_INVALID'
  | 'SCHEDULE_INVALID'
  | 'TRANSACTION_TYPE_INVALID'
  | 'ACCOUNT_IN_USE'
  | 'GROUP_IN_USE'
  | 'MUTATION_ID_FOREIGN'
  | 'PATCH_TARGET_DELETED'
  | 'PATCH_STATEMENT_SUPERSEDED'
  | 'PATCH_ALREADY_ASSIGNED'
  | 'PATCH_ITEM_ALREADY_MATCHED'
  | 'HOLDING_INSUFFICIENT'
  | 'SECURITY_IN_USE';

/** 所有 domain 驗證失敗都丟這個；API 層轉成 4xx 回應。 */
export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
