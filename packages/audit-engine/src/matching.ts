import type { ReasoningCode } from './reasoning.js';

export interface MatchRecord {
  id: string;
  amountMinor: bigint;
  currency: string;
  occurredDate?: string;
  postedDate?: string;
  merchantRaw?: string;
  merchantNormalized?: string;
  cardLast4?: string;
  installment?: { current: number; total: number };
  type?: 'purchase' | 'refund' | 'fee' | 'installment' | string;
}

export interface PairScoreContext {
  merchantAliases?: Readonly<Record<string, string>>;
  typicalPostingLagDays?: number;
  fxRateWithinTolerance?: boolean;
  fxRounding?: boolean;
  duplicateSuspect?: boolean;
  userHistoryMatch?: boolean;
  balancesStatement?: boolean;
}

export interface PairScore {
  score: number;
  reasoningCodes: ReasoningCode[];
  evidence: Record<string, string | number | boolean>;
  explanation: string;
}

const LABELS: Readonly<Partial<Record<ReasoningCode, string>>> = {
  AMT_EXACT: '金額相同',
  AMT_TENFOLD: '金額相差十倍',
  AMT_OFFSET_10: '金額相差 10',
  AMT_OFFSET_100: '金額相差 100',
  AMT_OFFSET_1000: '金額相差 1,000',
  AMT_SIGN_FLIPPED: '金額正負號相反',
  FX_RATE_WITHIN_TOL: '匯率換算在容差內',
  FX_ROUNDING: '差額符合匯率捨入',
  DATE_SAME: '日期相同',
  DATE_WITHIN_TOL: '日期在容許範圍內',
  POSTING_LAG_TYPICAL: '符合常見入帳延遲',
  DATE_FAR: '日期相距較遠',
  MERCHANT_ALIAS: '商家別名吻合',
  MERCHANT_NORMALIZED_EQ: '商家名稱吻合',
  MERCHANT_FUZZY: '商家名稱相似',
  MERCHANT_MISMATCH: '商家名稱不符',
  CARD_LAST4_MATCH: '卡號末四碼吻合',
  CARD_LAST4_MISMATCH: '卡號末四碼不符',
  INSTALLMENT_SEQ_MATCH: '分期期數吻合',
  INSTALLMENT_MISMATCH: '分期期數不符',
  REFUND_PAIR: '退款方向吻合',
  DUPLICATE_SUSPECT: '疑似重複',
  USER_HISTORY_MATCH: '符合過往確認紀錄',
  BALANCES_STATEMENT: '接受後帳單平衡',
};

/** 純規則 pair scorer；只使用呼叫端提供的事實，不做 IO 或推測。 */
export function scorePair(item: MatchRecord, transaction: MatchRecord, context: PairScoreContext = {}): PairScore {
  const codes: ReasoningCode[] = [];
  const evidence: PairScore['evidence'] = {
    statementAmountMinor: item.amountMinor.toString(),
    ledgerAmountMinor: transaction.amountMinor.toString(),
    statementCurrency: item.currency,
    ledgerCurrency: transaction.currency,
  };
  let score = 0;

  if (item.currency === transaction.currency) {
    const difference = abs(item.amountMinor - transaction.amountMinor);
    evidence['amountDifferenceMinor'] = difference.toString();
    if (item.amountMinor === transaction.amountMinor) add(codes, 'AMT_EXACT', () => (score += 0.45));
    else if (item.amountMinor === -transaction.amountMinor) add(codes, 'AMT_SIGN_FLIPPED', () => (score += 0.18));
    else if (tenfold(item.amountMinor, transaction.amountMinor)) add(codes, 'AMT_TENFOLD', () => (score += 0.16));
    else if (difference === 10n) add(codes, 'AMT_OFFSET_10', () => (score += 0.14));
    else if (difference === 100n) add(codes, 'AMT_OFFSET_100', () => (score += 0.12));
    else if (difference === 1000n) add(codes, 'AMT_OFFSET_1000', () => (score += 0.1));
  } else score -= 0.3;
  if (context.fxRateWithinTolerance) {
    evidence['fxRateWithinTolerance'] = true;
    add(codes, 'FX_RATE_WITHIN_TOL', () => (score += 0.18));
  }
  if (context.fxRounding) {
    evidence['fxRounding'] = true;
    add(codes, 'FX_ROUNDING', () => (score += 0.08));
  }

  const datePair = item.occurredDate && transaction.occurredDate
    ? { itemDate: item.occurredDate, transactionDate: transaction.occurredDate, basis: 'occurred' }
    : item.postedDate && transaction.postedDate
      ? { itemDate: item.postedDate, transactionDate: transaction.postedDate, basis: 'posted' }
      : null;
  if (datePair) {
    const days = civilDayDifference(datePair.itemDate, datePair.transactionDate);
    if (days !== null) {
      evidence['dateDifferenceDays'] = days;
      evidence['dateBasis'] = datePair.basis;
      if (days === 0) add(codes, 'DATE_SAME', () => (score += 0.2));
      else if (days <= 5) add(codes, 'DATE_WITHIN_TOL', () => (score += 0.12));
      else add(codes, 'DATE_FAR', () => (score -= 0.15));
      if (context.typicalPostingLagDays !== undefined && days === context.typicalPostingLagDays) {
        add(codes, 'POSTING_LAG_TYPICAL', () => (score += 0.08));
      }
    }
  }

  const itemMerchant = merchantName(item);
  const transactionMerchant = merchantName(transaction);
  if (itemMerchant && transactionMerchant) {
    evidence['statementMerchantNormalized'] = itemMerchant;
    evidence['ledgerMerchantNormalized'] = transactionMerchant;
    const alias = context.merchantAliases?.[normalizeMerchant(item.merchantRaw ?? itemMerchant)];
    if (alias && normalizeMerchant(alias) === transactionMerchant) {
      evidence['merchantAlias'] = alias;
      add(codes, 'MERCHANT_ALIAS', () => (score += 0.22));
    } else if (itemMerchant === transactionMerchant) {
      add(codes, 'MERCHANT_NORMALIZED_EQ', () => (score += 0.2));
    } else {
      const similarity = trigramDice(itemMerchant, transactionMerchant);
      evidence['merchantSimilarity'] = similarity;
      if (similarity >= 0.6) add(codes, 'MERCHANT_FUZZY', () => (score += 0.1));
      else add(codes, 'MERCHANT_MISMATCH', () => (score -= 0.12));
    }
  }

  if (item.cardLast4 && transaction.cardLast4) {
    evidence['statementCardLast4'] = item.cardLast4;
    evidence['ledgerCardLast4'] = transaction.cardLast4;
    if (item.cardLast4 === transaction.cardLast4) add(codes, 'CARD_LAST4_MATCH', () => (score += 0.2));
    else add(codes, 'CARD_LAST4_MISMATCH', () => (score -= 0.4));
  }
  if (item.installment && transaction.installment) {
    evidence['statementInstallment'] = `${item.installment.current}/${item.installment.total}`;
    evidence['ledgerInstallment'] = `${transaction.installment.current}/${transaction.installment.total}`;
    if (
      item.installment.current === transaction.installment.current &&
      item.installment.total === transaction.installment.total
    ) {
      add(codes, 'INSTALLMENT_SEQ_MATCH', () => (score += 0.15));
    } else add(codes, 'INSTALLMENT_MISMATCH', () => (score -= 0.25));
  }
  if ((item.type === 'refund' || item.amountMinor < 0n) && transaction.amountMinor > 0n) {
    add(codes, 'REFUND_PAIR', () => (score += 0.12));
  }
  if (context.duplicateSuspect) add(codes, 'DUPLICATE_SUSPECT', () => (score += 0.05));
  if (context.userHistoryMatch) add(codes, 'USER_HISTORY_MATCH', () => (score += 0.1));
  if (context.balancesStatement) add(codes, 'BALANCES_STATEMENT', () => (score += 0.08));

  score = Math.max(0, Math.min(1, Math.round(score * 10_000) / 10_000));
  if (codes.some((code) => CONTRADICTION_CODES.has(code))) score = Math.min(score, 0.8999);
  return {
    score,
    reasoningCodes: codes,
    evidence,
    explanation: codes.length > 0 ? codes.map((code) => explain(code, evidence)).join('、') : '沒有足夠配對證據',
  };
}

const CONTRADICTION_CODES = new Set<ReasoningCode>([
  'DATE_FAR',
  'MERCHANT_MISMATCH',
  'CARD_LAST4_MISMATCH',
  'INSTALLMENT_MISMATCH',
]);

function explain(code: ReasoningCode, evidence: PairScore['evidence']): string {
  if (code === 'DATE_WITHIN_TOL' || code === 'DATE_FAR') {
    return `日期差 ${evidence['dateDifferenceDays']} 天`;
  }
  if (code === 'MERCHANT_FUZZY') {
    return `商家名稱相似（${Math.round(Number(evidence['merchantSimilarity']) * 100)}%）`;
  }
  return LABELS[code] ?? code;
}

function add(codes: ReasoningCode[], code: ReasoningCode, applyWeight: () => void): void {
  codes.push(code);
  applyWeight();
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function tenfold(a: bigint, b: bigint): boolean {
  const left = abs(a);
  const right = abs(b);
  return left !== 0n && right !== 0n && (left === right * 10n || right === left * 10n);
}

function merchantName(record: MatchRecord): string {
  return normalizeMerchant(record.merchantNormalized ?? record.merchantRaw ?? '');
}

export function normalizeMerchant(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-Hant').replaceAll(/[\p{P}\p{S}\s]/gu, '');
}

function trigramDice(a: string, b: string): number {
  if (a === b) return 1;
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.length === 0 || right.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const gram of left) counts.set(gram, (counts.get(gram) ?? 0) + 1);
  let matches = 0;
  for (const gram of right) {
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      matches++;
      counts.set(gram, remaining - 1);
    }
  }
  return (2 * matches) / (left.length + right.length);
}

function trigrams(value: string): string[] {
  if (value.length < 3) return value ? [value] : [];
  return Array.from({ length: value.length - 2 }, (_, index) => value.slice(index, index + 3));
}

function civilDayDifference(a: string, b: string): number | null {
  const left = civilDay(a);
  const right = civilDay(b);
  return left === null || right === null ? null : Math.abs(left - right) / 86_400_000;
}

function civilDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = Date.UTC(year, month - 1, day);
  const parsed = new Date(instant);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? instant
    : null;
}
