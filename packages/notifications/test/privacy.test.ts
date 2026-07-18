import { describe, expect, it } from 'vitest';
import { formatAmountForPrivacy } from '../src/privacy.js';

describe('formatAmountForPrivacy', () => {
  it('full 模式顯示精確金額與千分位', () => {
    expect(formatAmountForPrivacy(1_234_567n, 'TWD', 'full')).toBe('NT$1,234,567');
    expect(formatAmountForPrivacy(-1_234_567n, 'TWD', 'full')).toBe('-NT$1,234,567');
    expect(formatAmountForPrivacy(1085n, 'USD', 'full')).toBe('US$10.85');
  });

  it('fuzzy 模式兩位有效數字＋中文萬/億語感（TWD/JPY）', () => {
    expect(formatAmountForPrivacy(1_234_567n, 'TWD', 'fuzzy')).toBe('約 NT$120 萬');
    expect(formatAmountForPrivacy(123_000_000n, 'TWD', 'fuzzy')).toBe('約 NT$1.2 億');
    expect(formatAmountForPrivacy(8_420n, 'TWD', 'fuzzy')).toBe('約 NT$8,400');
    expect(formatAmountForPrivacy(-1_234_567n, 'TWD', 'fuzzy')).toBe('約 -NT$120 萬');
  });

  it('fuzzy 模式非 TWD/JPY 幣別退化為千分位兩位有效數字', () => {
    expect(formatAmountForPrivacy(123_456_00n, 'USD', 'fuzzy')).toBe('約 US$120,000');
  });

  it('fuzzy 模式金額為 0 不出錯（精確值不加「約」）', () => {
    expect(formatAmountForPrivacy(0n, 'TWD', 'fuzzy')).toBe('NT$0');
  });

  it('hidden 模式一律回覆固定文字', () => {
    expect(formatAmountForPrivacy(1_234_567n, 'TWD', 'hidden')).toBe('金額已隱藏，請到 PWA 查看');
  });
});
