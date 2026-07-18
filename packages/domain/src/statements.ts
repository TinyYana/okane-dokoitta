import { addDays, addMonths, clampToMonthEnd, compareCivilDates, type CivilDate } from './dates.js';
import { DomainError } from './errors.js';

/** statements.status（DATA_MODEL §3.6）：open → closed → due → paid。表本身 M3 落地，狀態機先釘死。 */
export const STATEMENT_STATUSES = ['open', 'closed', 'due', 'paid'] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];

const STATEMENT_TRANSITIONS: Record<StatementStatus, readonly StatementStatus[]> = {
  open: ['closed'],
  closed: ['due', 'paid'],
  due: ['paid'],
  paid: [],
};

export function assertStatementTransition(from: StatementStatus, to: StatementStatus): void {
  if (!STATEMENT_TRANSITIONS[from].includes(to)) {
    throw new DomainError('INVALID_STATUS_TRANSITION', `帳單狀態不可從 ${from} 轉為 ${to}`);
  }
}

export interface CardCycle {
  /** 本期起日（上一結帳日翌日） */
  periodStart: CivilDate;
  /** 本期迄日＝本期結帳日 */
  periodEnd: CivilDate;
  statementDate: CivilDate;
  /** 本期帳單的繳款截止日（結帳日之後第一個 due_day） */
  dueDate: CivilDate;
}

function statementDateOfMonth(year: number, month: number, statementDay: number): CivilDate {
  return clampToMonthEnd(year, month, statementDay);
}

/**
 * 信用卡週期視圖（ACCT-5、F3）：給定結帳日/繳款日與「今天」，推導本期區間。
 * 月底結帳日（31）在小月自動取月底（DATA_MODEL §6 clampToMonthEnd）。
 */
export function computeCardCycle(statementDay: number, dueDay: number, today: CivilDate): CardCycle {
  if (statementDay < 1 || statementDay > 31 || dueDay < 1 || dueDay > 31) {
    throw new DomainError('DATE_INVALID', `結帳日/繳款日必須在 1–31: ${statementDay}/${dueDay}`);
  }
  const thisMonthStatement = statementDateOfMonth(today.year, today.month, statementDay);
  // 今天已過本月結帳日 → 本期結帳日在下個月
  const statementDate =
    compareCivilDates(today, thisMonthStatement) > 0
      ? statementDateOfMonth(...nextMonth(today.year, today.month), statementDay)
      : thisMonthStatement;
  const prevStatement = statementDateOfMonth(
    ...prevMonthOf(statementDate.year, statementDate.month),
    statementDay,
  );
  const periodStart = addDays(prevStatement, 1);
  // 繳款截止日：結帳日之後第一個 due_day（可能落在同月或次月）
  const dueSameMonth = clampToMonthEnd(statementDate.year, statementDate.month, dueDay);
  const dueDate =
    compareCivilDates(dueSameMonth, statementDate) > 0 ? dueSameMonth : addMonths(dueSameMonth, 1);
  return { periodStart, periodEnd: statementDate, statementDate, dueDate };
}

/** 上一期（已結帳）的週期：待繳金額顯示用。 */
export function computePreviousCardCycle(statementDay: number, dueDay: number, today: CivilDate): CardCycle {
  const current = computeCardCycle(statementDay, dueDay, today);
  const dayBeforePeriod = addDays(current.periodStart, -1);
  return computeCardCycle(statementDay, dueDay, dayBeforePeriod);
}

function nextMonth(year: number, month: number): [number, number] {
  return month === 12 ? [year + 1, 1] : [year, month + 1];
}

function prevMonthOf(year: number, month: number): [number, number] {
  return month === 1 ? [year - 1, 12] : [year, month - 1];
}

export const CARD_STATUSES = ['active', 'frozen', 'cancelled'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];
