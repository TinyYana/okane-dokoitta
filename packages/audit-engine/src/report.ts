export const AUDIT_CANDIDATE_KINDS = [
  'match',
  'missing_in_ledger',
  'missing_in_statement',
  'amount_mismatch',
  'date_mismatch',
  'wrong_card',
  'duplicate',
  'refund_unlinked',
  'deferred_posting',
  'installment_issue',
] as const;

export type AuditCandidateKind = (typeof AUDIT_CANDIDATE_KINDS)[number];

export interface AuditCandidateSummary {
  kind: AuditCandidateKind;
  score?: number;
}

export interface AuditReportStats {
  statementTotalMinor: bigint;
  ledgerExpectedMinor: bigint;
  differenceMinor: bigint;
  automaticMatches: number;
  highConfidence: number;
  lowConfidence: number;
  byKind: Record<AuditCandidateKind, number>;
  correctedBalanced: boolean;
}

export function buildAuditReportStats(input: {
  statementTotalMinor: bigint;
  ledgerExpectedMinor: bigint;
  candidates: readonly AuditCandidateSummary[];
  correctedDifferenceMinor?: bigint;
}): AuditReportStats {
  const byKind = Object.fromEntries(AUDIT_CANDIDATE_KINDS.map((kind) => [kind, 0])) as Record<AuditCandidateKind, number>;
  let highConfidence = 0;
  let lowConfidence = 0;
  for (const candidate of input.candidates) {
    byKind[candidate.kind]++;
    if (candidate.kind === 'match' && candidate.score !== undefined) {
      if (candidate.score >= 0.9) highConfidence++;
      else if (candidate.score >= 0.6) lowConfidence++;
    }
  }
  const differenceMinor = input.statementTotalMinor - input.ledgerExpectedMinor;
  return {
    statementTotalMinor: input.statementTotalMinor,
    ledgerExpectedMinor: input.ledgerExpectedMinor,
    differenceMinor,
    automaticMatches: highConfidence + lowConfidence,
    highConfidence,
    lowConfidence,
    byKind,
    correctedBalanced: (input.correctedDifferenceMinor ?? differenceMinor) === 0n,
  };
}
