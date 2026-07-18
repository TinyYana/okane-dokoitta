import { DomainError } from './errors.js';

/**
 * 民用日期（AGENTS §5）：無時區的 YYYY-MM-DD，以帳本時區解讀（預設 Asia/Taipei）。
 * `*_at` 時間點一律 UTC ISO 8601，兩者不得混用。
 * 這裡是純日期運算——不碰系統時鐘（測試注入 clock，TESTING §3）。
 */

export interface CivilDate {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
}

export const DEFAULT_LEDGER_TIMEZONE = 'Asia/Taipei';

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseCivilDate(input: string): CivilDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) throw new DomainError('DATE_INVALID', `日期格式必須是 YYYY-MM-DD: ${input}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new DomainError('DATE_INVALID', `無效日期: ${input}`);
  }
  return { year, month, day };
}

export function formatCivilDate(date: CivilDate): string {
  const mm = String(date.month).padStart(2, '0');
  const dd = String(date.day).padStart(2, '0');
  return `${date.year}-${mm}-${dd}`;
}

/** 結帳日在月底：statement_day=31 在小月取當月最後一天（DATA_MODEL §6）。 */
export function clampToMonthEnd(year: number, month: number, day: number): CivilDate {
  return { year, month, day: Math.min(day, daysInMonth(year, month)) };
}

/** days-from-civil（Howard Hinnant 演算法）：民用日期 → 連續日序號。 */
export function toSerialDay(date: CivilDate): number {
  const y = date.year - (date.month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (date.month + (date.month > 2 ? -3 : 9)) + 2) / 5) + date.day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function fromSerialDay(serial: number): CivilDate {
  const z = serial + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: y + (month <= 2 ? 1 : 0), month, day };
}

export function addDays(date: CivilDate, days: number): CivilDate {
  return fromSerialDay(toSerialDay(date) + days);
}

/** 加月：日超出目標月時 clamp 到月底（1/31 +1mo → 2/28）。 */
export function addMonths(date: CivilDate, months: number): CivilDate {
  const total = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return clampToMonthEnd(year, month, date.day);
}

export function compareCivilDates(a: CivilDate, b: CivilDate): -1 | 0 | 1 {
  const sa = toSerialDay(a);
  const sb = toSerialDay(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/**
 * UTC 時間點 → 帳本時區的民用日期（台北 23:50 的消費落在當天，不是 UTC 日）。
 * Intl 是純計算，無 IO。
 */
export function civilDateFromInstant(isoUtc: string, timeZone: string = DEFAULT_LEDGER_TIMEZONE): CivilDate {
  const ms = Date.parse(isoUtc);
  if (Number.isNaN(ms)) throw new DomainError('DATE_INVALID', `無效時間點: ${isoUtc}`);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA 格式為 YYYY-MM-DD
  return parseCivilDate(formatter.format(new Date(ms)));
}

/** 帳本時區的民用日期中午 → UTC 時間點。用中午避開日光節約時間切換缺口。 */
export function instantFromCivilDate(date: CivilDate, timeZone: string = DEFAULT_LEDGER_TIMEZONE): string {
  const target = Date.UTC(date.year, date.month - 1, date.day, 12);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let instant = target;
  for (let i = 0; i < 3; i += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    const displayed = Date.UTC(Number(parts['year']), Number(parts['month']) - 1, Number(parts['day']), Number(parts['hour']), Number(parts['minute']), Number(parts['second']));
    instant += target - displayed;
  }
  const iso = new Date(instant).toISOString();
  if (compareCivilDates(civilDateFromInstant(iso, timeZone), date) !== 0) {
    throw new DomainError('DATE_INVALID', `無法以時區 ${timeZone} 解讀日期 ${formatCivilDate(date)}`);
  }
  return iso;
}
