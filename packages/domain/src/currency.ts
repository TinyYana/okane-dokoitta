import { DomainError } from './errors.js';

/**
 * 幣別註冊表（DATA_MODEL §1）。
 * 新增幣別＝在這裡加一列（code + exponent + 顯示符號），不需 schema 變更。
 * TWD=0 採銀行實務慣例（OPEN_QUESTIONS Q4，作者核可）。
 */
export interface CurrencyInfo {
  code: string;
  /** 最小貨幣單位指數：minor = major × 10^exponent */
  exponent: number;
  symbol: string;
}

const REGISTRY: Record<string, CurrencyInfo> = {
  TWD: { code: 'TWD', exponent: 0, symbol: 'NT$' },
  JPY: { code: 'JPY', exponent: 0, symbol: '¥' },
  USD: { code: 'USD', exponent: 2, symbol: 'US$' },
};

export function isKnownCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, code);
}

export function currencyInfo(code: string): CurrencyInfo {
  const info = REGISTRY[code];
  if (!info) throw new DomainError('CURRENCY_UNKNOWN', `未知幣別: ${code}`);
  return info;
}

export function currencyExponent(code: string): number {
  return currencyInfo(code).exponent;
}

export function knownCurrencies(): CurrencyInfo[] {
  return Object.values(REGISTRY);
}
