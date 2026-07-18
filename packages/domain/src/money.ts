import { currencyExponent } from './currency.js';
import { DomainError } from './errors.js';

/**
 * Money module（AGENTS §5）：
 * - 金額一律整數最小貨幣單位（bigint）。禁止浮點數儲存、運算、傳輸。
 * - 所有除法（分期、匯率換算）集中在這裡，捨入規則統一：
 *   ROUND HALF AWAY FROM ZERO（四捨五入；負數對稱）。
 */

export interface Money {
  amountMinor: bigint;
  currency: string;
}

export function money(amountMinor: bigint, currency: string): Money {
  currencyExponent(currency); // 驗證幣別存在
  return { amountMinor, currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new DomainError('CURRENCY_MISMATCH', `幣別不一致: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function negate(a: Money): Money {
  return { amountMinor: -a.amountMinor, currency: a.currency };
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0n;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function pow10(exp: number): bigint {
  let result = 1n;
  for (let i = 0; i < exp; i++) result *= 10n;
  return result;
}

/**
 * 唯一的除法出口：round half away from zero。
 * 任何金額除法（分期、匯率）都必須經過這裡。
 */
export function divideRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new DomainError('AMOUNT_INVALID', '除數為零');
  const sign = (numerator < 0n) !== (denominator < 0n) ? -1n : 1n;
  const n = abs(numerator);
  const d = abs(denominator);
  const q = n / d;
  const r = n % d;
  const rounded = r * 2n >= d ? q + 1n : q;
  return sign * rounded;
}

/**
 * 金額字串 → 最小單位整數。不經過浮點數。
 * 接受 "185"、"1.85"、"-3.5"；小數位數超過幣別指數 → 拒絕。
 */
export function parseAmount(input: string, currency: string): bigint {
  const exponent = currencyExponent(currency);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!match) throw new DomainError('AMOUNT_INVALID', `金額格式錯誤: ${input}`);
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > exponent) {
    throw new DomainError('AMOUNT_INVALID', `${currency} 最多 ${exponent} 位小數: ${input}`);
  }
  const padded = fraction.padEnd(exponent, '0');
  const minor = BigInt(whole + padded);
  return sign === '-' ? -minor : minor;
}

/** 最小單位整數 → 十進位字串（"1234" → USD "12.34"）。顯示排版仍屬 UI，這裡只給正確的十進位表示。 */
export function amountToDecimalString(amountMinor: bigint, currency: string): string {
  const exponent = currencyExponent(currency);
  const sign = amountMinor < 0n ? '-' : '';
  const digits = abs(amountMinor).toString().padStart(exponent + 1, '0');
  if (exponent === 0) return sign + digits;
  return `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/**
 * 分攤（分期）：把總額分成 n 份，各份差距 ≤1 最小單位，總和恰等於原額（最大餘數法）。
 */
export function allocate(total: bigint, parts: number): bigint[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new DomainError('AMOUNT_INVALID', `分攤份數必須是正整數: ${parts}`);
  }
  const n = BigInt(parts);
  const sign = total < 0n ? -1n : 1n;
  const t = abs(total);
  const base = t / n;
  const remainder = t % n;
  const result: bigint[] = [];
  for (let i = 0n; i < n; i++) {
    result.push(sign * (base + (i < remainder ? 1n : 0n)));
  }
  return result;
}

/** 十進位比率字串（如 "32.045"）→ {mantissa, scale}。匯率是比率不是金額，允許高精度。 */
export function parseDecimalRate(rate: string): { mantissa: bigint; scale: number } {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(rate.trim());
  if (!match || BigInt(match[1] + (match[2] ?? '')) === 0n) {
    throw new DomainError('AMOUNT_INVALID', `匯率格式錯誤或為零: ${rate}`);
  }
  const [, whole, fraction = ''] = match;
  return { mantissa: BigInt(whole + fraction), scale: fraction.length };
}

/**
 * 匯率換算：from 幣最小單位 × rate（1 from 主單位 = rate to 主單位）→ to 幣最小單位。
 * 全程 bigint，最後一步 divideRound 捨入回整數。
 */
export function convert(amount: Money, toCurrency: string, rate: string): Money {
  const fromExp = currencyExponent(amount.currency);
  const toExp = currencyExponent(toCurrency);
  const { mantissa, scale } = parseDecimalRate(rate);
  const numerator = amount.amountMinor * mantissa * pow10(toExp);
  const denominator = pow10(scale) * pow10(fromExp);
  return { amountMinor: divideRound(numerator, denominator), currency: toCurrency };
}
