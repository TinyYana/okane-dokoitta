import { parseCsv } from '../csv.js';
import {
  amountMinor,
  assertInputSize,
  normalizedCurrency,
  parseInstallment,
  statementBase,
  transactionType,
  validDate,
  validLast4,
} from '../shared.js';
import { ImporterError, type CsvColumn, type Importer, type ImportedTransaction, type ParseWarning } from '../types.js';

const ALIASES: Record<CsvColumn, string[]> = {
  sourceId: ['sourceid', 'id', '交易編號'],
  occurredAt: ['occurredat', 'date', 'transactiondate', '交易日期', '日期'],
  postedAt: ['postedat', 'posteddate', '入帳日期'],
  merchant: ['merchant', 'description', 'name', '商家', '說明', '摘要'],
  amount: ['amount', '金額', '交易金額'],
  currency: ['currency', '幣別'],
  type: ['type', '類型'],
  accountHint: ['accounthint', 'account', '帳戶'],
  cardLast4: ['cardlast4', '末四碼', '卡號末四碼'],
  installment: ['installment', '分期'],
};

function key(value: string): string {
  return value.replace(/^\uFEFF/, '').trim().toLowerCase().replaceAll(/[_\s-]/g, '');
}

function indexColumns(headers: string[], configured: Partial<Record<CsvColumn, string>> | undefined): Partial<Record<CsvColumn, number>> {
  const normalized = headers.map(key);
  return Object.fromEntries(
    (Object.keys(ALIASES) as CsvColumn[]).flatMap((field) => {
      const requested = configured?.[field];
      const index = requested ? normalized.indexOf(key(requested)) : normalized.findIndex((header) => ALIASES[field].includes(header));
      return index < 0 ? [] : [[field, index]];
    }),
  );
}

function rawRecord(headers: string[], cells: string[]): Record<string, string> {
  return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
}

export const genericCsvImporter: Importer = {
  id: 'generic-csv',
  displayName: '通用 CSV',
  accepts: ['csv'],
  detect(input) {
    if (input.kind !== 'csv') return 0;
    const header = input.text.slice(0, 4_096).split(/\r?\n/, 1)[0] ?? '';
    const matches = [...ALIASES.merchant, ...ALIASES.amount, ...ALIASES.occurredAt].filter((alias) => key(header).includes(alias)).length;
    return Math.min(0.95, 0.35 + matches * 0.15);
  },
  async parse(input) {
    if (input.kind !== 'csv') throw new ImporterError('FORMAT_INVALID', 'generic-csv 只接受 CSV');
    assertInputSize(input.text);
    const rows = parseCsv(input.text, input.delimiter ?? ',');
    const headerRow = rows.shift();
    if (!headerRow) throw new ImporterError('FORMAT_INVALID', 'CSV 沒有標題列');
    const headers = headerRow.cells.map((header) => header.replace(/^\uFEFF/, '').trim());
    const columns = indexColumns(headers, input.columns);
    if (columns.merchant === undefined || columns.amount === undefined) {
      throw new ImporterError('FORMAT_INVALID', 'CSV 必須對應 merchant 與 amount 欄位');
    }

    const warnings: ParseWarning[] = [];
    const transactions: ImportedTransaction[] = [];
    for (const row of rows) {
      const value = (field: CsvColumn) => {
        const index = columns[field];
        return index === undefined ? undefined : row.cells[index];
      };
      try {
        const currency = normalizedCurrency(value('currency') || input.defaults?.currency);
        const amount = amountMinor(value('amount') ?? '', currency);
        const installment = parseInstallment(value('installment'));
        const merchantRaw = value('merchant')?.trim();
        if (!merchantRaw) throw new ImporterError('FORMAT_INVALID', '缺少商家名稱');
        const occurredAt = validDate(value('occurredAt'), 'occurredAt');
        const postedAt = validDate(value('postedAt'), 'postedAt');
        const cardLast4 = validLast4(value('cardLast4') || input.defaults?.cardLast4);
        transactions.push({
          merchantRaw,
          amountMinor: amount,
          currency,
          type: transactionType(value('type'), amount, Boolean(installment)),
          metadata: { line: row.line, raw: rawRecord(headers, row.cells) },
          ...(value('sourceId') ? { sourceId: value('sourceId')!.trim() } : {}),
          ...(value('accountHint') ? { accountHint: value('accountHint')!.trim() } : {}),
          ...(input.defaults?.institution ? { institution: input.defaults.institution } : {}),
          ...(occurredAt ? { occurredAt } : {}),
          ...(postedAt ? { postedAt } : {}),
          ...(cardLast4 ? { cardLast4 } : {}),
          ...(installment ? { installment } : {}),
        });
      } catch (error) {
        warnings.push({ code: 'ROW_SKIPPED', line: row.line, message: error instanceof Error ? error.message : '無法解析資料列', raw: row.cells.join(input.delimiter ?? ',') });
      }
    }
    if (transactions.length === 0) throw new ImporterError('FORMAT_INVALID', 'CSV 沒有可匯入的資料列');
    const currencies = new Set(transactions.map((transaction) => transaction.currency));
    if (currencies.size !== 1) throw new ImporterError('FORMAT_INVALID', '單一帳單不可混用多種幣別');
    const currency = transactions[0]!.currency;
    return { statement: { ...statementBase('generic-csv', input.defaults, currency), transactions }, warnings };
  },
};
