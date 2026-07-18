import { amountToDecimalString, currencyInfo } from '@okane-dokoitta/domain';

export type PrivacyMode = 'full' | 'fuzzy' | 'anomaly_only' | 'hidden';

/**
 * DISCORD_INTEGRATION §6：Discord/Push 訊息文字組裝（這裡的顯示格式化屬於 Discord 通道的 UI 層，
 * 與 apps/web 各自獨立，AGENTS §5「顯示格式化只在 UI 層做」不要求兩者共用同一份格式化函式）。
 * full 精確金額；fuzzy 兩位有效數字＋中文萬/億語感；hidden 完全不顯示金額。
 */
export function formatAmountForPrivacy(amountMinor: bigint, currency: string, mode: PrivacyMode): string {
  if (mode === 'hidden') return '金額已隱藏，請到 PWA 查看';
  return mode === 'fuzzy' ? formatFuzzy(amountMinor, currency) : formatFull(amountMinor, currency);
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatFull(amountMinor: bigint, currency: string): string {
  const info = currencyInfo(currency);
  const decimal = amountToDecimalString(amountMinor, currency);
  const negative = decimal.startsWith('-');
  const [whole = '', fraction] = decimal.replace('-', '').split('.');
  return `${negative ? '-' : ''}${info.symbol}${groupThousands(whole)}${fraction ? `.${fraction}` : ''}`;
}

/** 兩位有效數字，去除小數位（DISCORD_INTEGRATION §6 範例：約 NT$ 120 萬）。 */
function formatFuzzy(amountMinor: bigint, currency: string): string {
  const info = currencyInfo(currency);
  const negative = amountMinor < 0n;
  const whole = (negative ? -amountMinor : amountMinor) / 10n ** BigInt(info.exponent);
  const sign = negative ? '-' : '';
  if (whole === 0n) return `${sign}${info.symbol}0`;
  const rounded = roundToSignificantFigures(whole, 2);
  const magnitude = currency === 'TWD' || currency === 'JPY' ? formatChineseMagnitude(rounded) : groupThousands(rounded.toString());
  return `約 ${sign}${info.symbol}${magnitude}`;
}

function roundToSignificantFigures(value: bigint, sigFigs: number): bigint {
  const digits = value.toString().length;
  if (digits <= sigFigs) return value;
  const divisor = 10n ** BigInt(digits - sigFigs);
  return ((value + divisor / 2n) / divisor) * divisor;
}

function formatChineseMagnitude(value: bigint): string {
  if (value >= 100_000_000n) return `${(Number(value) / 100_000_000).toFixed(value % 100_000_000n === 0n ? 0 : 1)} 億`;
  if (value >= 10_000n) return `${(Number(value) / 10_000).toFixed(value % 10_000n === 0n ? 0 : 1)} 萬`;
  return groupThousands(value.toString());
}
