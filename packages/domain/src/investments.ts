import { currencyExponent } from './currency.js';
import { DomainError } from './errors.js';
import { divideRound, parseDecimalRate } from './money.js';

/**
 * 投資持倉數學（INVESTMENT_MODEL §3、§4）：平均成本法、市值換算。
 * 買賣本身的資產轉換分錄仍由 posting.ts 處理；這裡只算「這檔標的目前多少股、成本多少」。
 */

export const SECURITY_KINDS = ['stock', 'etf'] as const;
export type SecurityKind = (typeof SECURITY_KINDS)[number];

export const RATE_SOURCES = ['manual', 'provider'] as const;
export type RateSource = (typeof RATE_SOURCES)[number];

/** 持股數量固定 6 位小數精度（零股／美股碎股都夠用），bigint 儲存避免浮點誤差。 */
const QUANTITY_SCALE = 6;
const QUANTITY_UNIT = 1_000_000n;

function pow10(exp: number): bigint {
  let result = 1n;
  for (let i = 0; i < exp; i++) result *= 10n;
  return result;
}

/** 數量字串（"100"、"12.5"）→ micro units。不接受 0 或負數。 */
export function parseQuantity(input: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!match) throw new DomainError('AMOUNT_INVALID', `數量格式錯誤: ${input}`);
  const [, whole, fraction = ''] = match;
  if (fraction.length > QUANTITY_SCALE) {
    throw new DomainError('AMOUNT_INVALID', `數量最多 ${QUANTITY_SCALE} 位小數: ${input}`);
  }
  const micro = BigInt(whole + fraction.padEnd(QUANTITY_SCALE, '0'));
  if (micro <= 0n) throw new DomainError('AMOUNT_NOT_POSITIVE', `數量必須為正: ${input}`);
  return micro;
}

/** micro units → 十進位字串顯示。 */
export function formatQuantity(quantityMicro: bigint): string {
  const digits = quantityMicro.toString().padStart(QUANTITY_SCALE + 1, '0');
  const whole = digits.slice(0, -QUANTITY_SCALE).replace(/^0+(?=\d)/, '') || '0';
  const fraction = digits.slice(-QUANTITY_SCALE).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export interface HoldingState {
  quantityMicro: bigint;
  costBasisMinor: bigint;
}

/** 買入：加量、加成本基礎（買入交易金額已含手續費，直接併入成本）。 */
export function applyBuy(current: HoldingState | undefined, addQuantityMicro: bigint, addCostMinor: bigint): HoldingState {
  if (addQuantityMicro <= 0n) throw new DomainError('AMOUNT_NOT_POSITIVE', '買入數量必須為正');
  return {
    quantityMicro: (current?.quantityMicro ?? 0n) + addQuantityMicro,
    costBasisMinor: (current?.costBasisMinor ?? 0n) + addCostMinor,
  };
}

/** 賣出（平均成本法，INVESTMENT_MODEL §3）：依比例攤提成本；回傳更新後持倉與本次賣出的成本基礎。 */
export function applySell(
  current: HoldingState | undefined,
  removeQuantityMicro: bigint,
): { next: HoldingState; costBasisMinor: bigint } {
  if (removeQuantityMicro <= 0n) throw new DomainError('AMOUNT_NOT_POSITIVE', '賣出數量必須為正');
  if (!current || removeQuantityMicro > current.quantityMicro) {
    throw new DomainError('HOLDING_INSUFFICIENT', '賣出數量超過目前持倉');
  }
  const costBasisMinor = divideRound(current.costBasisMinor * removeQuantityMicro, current.quantityMicro);
  return {
    next: {
      quantityMicro: current.quantityMicro - removeQuantityMicro,
      costBasisMinor: current.costBasisMinor - costBasisMinor,
    },
    costBasisMinor,
  };
}

/** 持倉市值（標的計價幣別）：quantity × 最新價格，捨入到該幣別最小單位（INVESTMENT_MODEL §4）。 */
export function computeMarketValueMinor(quantityMicro: bigint, priceDecimal: string, currency: string): bigint {
  const { mantissa, scale } = parseDecimalRate(priceDecimal);
  const exponent = currencyExponent(currency);
  const numerator = quantityMicro * mantissa * pow10(exponent);
  const denominator = QUANTITY_UNIT * pow10(scale);
  return divideRound(numerator, denominator);
}
