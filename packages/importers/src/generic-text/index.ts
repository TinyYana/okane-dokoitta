import {
  amountMinor,
  assertInputSize,
  normalizedCurrency,
  statementBase,
  transactionType,
  validDate,
  validLast4,
} from '../shared.js';
import { IMPORT_LIMITS, ImporterError, type Importer, type ImportedTransaction, type ParseWarning } from '../types.js';

function fields(line: string): string[] {
  return line.includes('\t') ? line.split('\t') : line.split('|');
}

export const genericTextImporter: Importer = {
  id: 'generic-text',
  displayName: '通用文字',
  accepts: ['text', 'pdf'],
  detect(input) {
    if (input.kind === 'csv') return 0;
    const text = input.kind === 'pdf' ? input.extractedText : input.text;
    const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 10);
    const matches = lines.filter((line) => /^\d{4}-\d{2}-\d{2}\s*(?:\||\t)/.test(line)).length;
    return lines.length === 0 ? 0 : Math.min(0.9, matches / lines.length);
  },
  async parse(input) {
    if (input.kind === 'csv') throw new ImporterError('FORMAT_INVALID', 'generic-text 不接受 CSV');
    const text = input.kind === 'pdf' ? input.extractedText : input.text;
    assertInputSize(text);
    const lines = text.split(/\r?\n/);
    if (lines.length > IMPORT_LIMITS.maxRows) throw new ImporterError('TOO_MANY_ROWS', `輸入超過 ${IMPORT_LIMITS.maxRows} 列上限`);
    const warnings: ParseWarning[] = [];
    const transactions: ImportedTransaction[] = [];
    for (const [index, raw] of lines.entries()) {
      if (!raw.trim()) continue;
      try {
        const parts = fields(raw).map((part) => part.trim());
        if (parts.length < 3 || parts.length > 5) throw new ImporterError('FORMAT_INVALID', '格式必須是 日期 | 商家 | 金額 | 幣別 | 類型');
        if (parts.some((part) => part.length > IMPORT_LIMITS.maxCellCharacters)) throw new ImporterError('CELL_TOO_LARGE', '欄位過長');
        const [date, merchantRaw, amountText, currencyText, typeText] = parts;
        if (!merchantRaw) throw new ImporterError('FORMAT_INVALID', '缺少商家名稱');
        const currency = normalizedCurrency(currencyText || input.defaults?.currency);
        const amount = amountMinor(amountText ?? '', currency);
        const occurredAt = validDate(date, 'occurredAt');
        const cardLast4 = validLast4(input.defaults?.cardLast4);
        transactions.push({
          ...(occurredAt ? { occurredAt } : {}),
          merchantRaw,
          amountMinor: amount,
          currency,
          type: transactionType(typeText, amount, false),
          metadata: { line: index + 1, raw },
          ...(input.defaults?.institution ? { institution: input.defaults.institution } : {}),
          ...(cardLast4 ? { cardLast4 } : {}),
        });
      } catch (error) {
        warnings.push({ code: 'ROW_SKIPPED', line: index + 1, message: error instanceof Error ? error.message : '無法解析資料列', raw });
      }
    }
    if (transactions.length === 0) throw new ImporterError('FORMAT_INVALID', '文字沒有可匯入的資料列');
    const currencies = new Set(transactions.map((transaction) => transaction.currency));
    if (currencies.size !== 1) throw new ImporterError('FORMAT_INVALID', '單一帳單不可混用多種幣別');
    const currency = transactions[0]!.currency;
    return { statement: { ...statementBase('generic-text', input.defaults, currency), transactions }, warnings };
  },
};
