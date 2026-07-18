export const MAX_DISCREPANCY_CANDIDATES = 300;
export const DISCREPANCY_TIMEOUT_MS = 2_000;

export type DiscrepancyRole =
  | 'statement_unmatched'
  | 'ledger_unmatched'
  | 'matched'
  | 'payment_as_expense'
  | 'refund_unoffset'
  | 'transfer_missing_side'
  | 'period_boundary';

export interface DiscrepancyCandidate {
  id: string;
  amountMinor: bigint;
  /** `matched` 時的帳本金額；差額 = statement - ledger。 */
  ledgerAmountMinor?: bigint;
  currency?: string;
  ledgerCurrency?: string;
  role?: DiscrepancyRole;
}

export type DiscrepancyHypothesisKind =
  | 'single_missing'
  | 'amount_mismatch'
  | 'sign_flipped'
  | 'tenfold_error'
  | 'currency_or_decimal_error'
  | 'payment_as_expense'
  | 'refund_unoffset'
  | 'transfer_missing_side'
  | 'period_boundary'
  | 'two_sum'
  | 'three_sum';

export interface DiscrepancyHypothesis {
  kind: DiscrepancyHypothesisKind;
  candidateIds: string[];
  deltaMinor: bigint;
  confidence: number;
  explanation: string;
}

export interface DiscrepancyResult {
  differenceMinor: bigint;
  hypotheses: DiscrepancyHypothesis[];
  unresolvedMinor: bigint;
  timedOut: boolean;
}

/** AUDIT_ENGINE §6：依單筆、常見錯誤、兩筆、三筆順序找出可完整解釋差額的假說。 */
export function solveDiscrepancy(
  differenceMinor: bigint,
  candidates: readonly DiscrepancyCandidate[],
  timeoutMs = DISCREPANCY_TIMEOUT_MS,
): DiscrepancyResult {
  if (candidates.length > MAX_DISCREPANCY_CANDIDATES) {
    throw new RangeError(`候選最多 ${MAX_DISCREPANCY_CANDIDATES} 筆，請先收窄日期區間`);
  }
  if (differenceMinor === 0n) return result(differenceMinor, [], false);
  const singles = candidates.flatMap((candidate) => singleHypothesis(candidate, differenceMinor));
  if (singles.length > 0) return result(differenceMinor, singles, false);

  const common = candidates.flatMap((candidate) => commonHypotheses(candidate, differenceMinor));
  if (common.length > 0) return result(differenceMinor, common, false);

  const terms = candidates.flatMap((candidate) => {
    const delta = combinationDelta(candidate);
    return delta === null ? [] : [{ candidate, delta }];
  });
  const pairs = twoSum(terms, differenceMinor);
  if (pairs.length > 0) return result(differenceMinor, pairs, false);

  const startedAt = Date.now();
  const triples: DiscrepancyHypothesis[] = [];
  const seen = new Set<string>();
  for (let first = 0; first < terms.length - 2; first++) {
    if (Date.now() - startedAt >= timeoutMs) return result(differenceMinor, [], true);
    const complements = new Map<bigint, number[]>();
    for (let second = first + 1; second < terms.length; second++) {
      if (Date.now() - startedAt >= timeoutMs) return result(differenceMinor, [], true);
      const firstTerm = terms[first];
      const secondTerm = terms[second];
      if (!firstTerm || !secondTerm) continue;
      const need = differenceMinor - firstTerm.delta - secondTerm.delta;
      for (const third of complements.get(need) ?? []) {
        if (Date.now() - startedAt >= timeoutMs) return result(differenceMinor, [], true);
        const thirdTerm = terms[third];
        if (!thirdTerm) continue;
        const ids = [firstTerm.candidate.id, thirdTerm.candidate.id, secondTerm.candidate.id].sort();
        const key = ids.join('\u0000');
        if (!seen.has(key)) {
          seen.add(key);
          triples.push(hypothesis('three_sum', ids, differenceMinor, 0.6, '三筆組合可解釋差額'));
        }
      }
      const indexes = complements.get(secondTerm.delta) ?? [];
      indexes.push(second);
      complements.set(secondTerm.delta, indexes);
    }
  }
  return result(differenceMinor, triples, false);
}

function singleHypothesis(candidate: DiscrepancyCandidate, difference: bigint): DiscrepancyHypothesis[] {
  const role = candidate.role ?? 'statement_unmatched';
  const delta = role === 'ledger_unmatched' ? -candidate.amountMinor : candidate.amountMinor;
  if ((role === 'statement_unmatched' || role === 'ledger_unmatched') && delta === difference) {
    return [hypothesis('single_missing', [candidate.id], delta, 1, '一筆未配對項目可完整解釋差額')];
  }
  return [];
}

function commonHypotheses(candidate: DiscrepancyCandidate, difference: bigint): DiscrepancyHypothesis[] {
  const hypotheses: DiscrepancyHypothesis[] = [];
  const role = candidate.role ?? 'statement_unmatched';
  if (role === 'matched' && candidate.ledgerAmountMinor !== undefined) {
    const delta = candidate.amountMinor - candidate.ledgerAmountMinor;
    if (delta === difference) {
      const kind = candidate.amountMinor === -candidate.ledgerAmountMinor
        ? 'sign_flipped'
        : tenfold(candidate.amountMinor, candidate.ledgerAmountMinor)
          ? 'tenfold_error'
          : candidate.currency !== candidate.ledgerCurrency || decimalScale(candidate.amountMinor, candidate.ledgerAmountMinor)
            ? 'currency_or_decimal_error'
          : 'amount_mismatch';
      hypotheses.push(hypothesis(kind, [candidate.id], delta, 0.95, '已配對項目的金額差可完整解釋差額'));
    }
  }
  const commonDeltas: Partial<Record<DiscrepancyRole, readonly bigint[]>> = {
    payment_as_expense: [-abs(candidate.amountMinor)],
    refund_unoffset: [candidate.amountMinor < 0n ? candidate.amountMinor : -candidate.amountMinor],
    transfer_missing_side: [abs(candidate.amountMinor), -abs(candidate.amountMinor)],
    period_boundary: [abs(candidate.amountMinor), -abs(candidate.amountMinor)],
  };
  for (const delta of commonDeltas[role] ?? []) {
    const kind = commonKind(role);
    if (kind && delta === difference) {
      hypotheses.push(hypothesis(kind, [candidate.id], delta, 0.9, commonExplanation(role)));
    }
  }
  return hypotheses;
}

function commonKind(role: DiscrepancyRole): DiscrepancyHypothesisKind | null {
  switch (role) {
    case 'payment_as_expense':
    case 'refund_unoffset':
    case 'transfer_missing_side':
    case 'period_boundary':
      return role;
    default:
      return null;
  }
}

function twoSum(
  terms: ReadonlyArray<{ candidate: DiscrepancyCandidate; delta: bigint }>,
  difference: bigint,
): DiscrepancyHypothesis[] {
  const result: DiscrepancyHypothesis[] = [];
  const seen = new Map<bigint, number[]>();
  for (let index = 0; index < terms.length; index++) {
    const term = terms[index];
    if (!term) continue;
    for (const otherIndex of seen.get(difference - term.delta) ?? []) {
      const other = terms[otherIndex];
      if (!other) continue;
      result.push(hypothesis('two_sum', [other.candidate.id, term.candidate.id].sort(), difference, 0.75, '兩筆組合可解釋差額'));
    }
    const indexes = seen.get(term.delta) ?? [];
    indexes.push(index);
    seen.set(term.delta, indexes);
  }
  return result;
}

function combinationDelta(candidate: DiscrepancyCandidate): bigint | null {
  const role = candidate.role ?? 'statement_unmatched';
  if (role === 'statement_unmatched') return candidate.amountMinor;
  if (role === 'ledger_unmatched') return -candidate.amountMinor;
  return null;
}

function result(differenceMinor: bigint, hypotheses: DiscrepancyHypothesis[], timedOut: boolean): DiscrepancyResult {
  hypotheses.sort((a, b) => b.confidence - a.confidence || a.candidateIds.length - b.candidateIds.length || a.candidateIds.join().localeCompare(b.candidateIds.join()));
  return { differenceMinor, hypotheses, unresolvedMinor: hypotheses.length > 0 ? 0n : differenceMinor, timedOut };
}

function hypothesis(
  kind: DiscrepancyHypothesisKind,
  candidateIds: string[],
  deltaMinor: bigint,
  confidence: number,
  explanation: string,
): DiscrepancyHypothesis {
  return { kind, candidateIds, deltaMinor, confidence, explanation };
}

function commonExplanation(role: DiscrepancyRole): string {
  switch (role) {
    case 'payment_as_expense': return '信用卡繳款可能被重複計為支出';
    case 'refund_unoffset': return '退款可能尚未抵銷原交易';
    case 'transfer_missing_side': return '轉帳可能缺少一端';
    case 'period_boundary': return '交易可能落在帳單期間邊界之外';
    default: return '常見錯誤可解釋差額';
  }
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function tenfold(a: bigint, b: bigint): boolean {
  const left = abs(a);
  const right = abs(b);
  return left !== 0n && right !== 0n && (left === right * 10n || right === left * 10n);
}

function decimalScale(a: bigint, b: bigint): boolean {
  const left = abs(a);
  const right = abs(b);
  return left !== 0n && right !== 0n && (
    left === right * 100n || right === left * 100n || left === right * 1000n || right === left * 1000n
  );
}
