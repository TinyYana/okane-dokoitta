import { addDays, addMonths, formatCivilDate, parseCivilDate, type CivilDate } from '@okane-dokoitta/domain';
import { parseCsv, type CsvRow } from '../csv.js';
import { amountMinor, assertInputSize, transactionType } from '../shared.js';
import { ImporterError, type ImportedTransaction, type Importer, type ParseWarning } from '../types.js';

const INSTITUTION = '聯邦銀行';
const SUMMARY_HEADERS = ['帳單結帳日', '繳款截止日', '本期應繳金額'] as const;
const DETAIL_HEADERS = ['入帳日', '消費日', '消費明細', '新臺幣金額'] as const;

function headersOf(row: CsvRow): string[] {
  return row.cells.map((cell) => cell.replace(/^\uFEFF/, '').trim());
}

function hasHeaders(row: CsvRow, required: readonly string[]): boolean {
  const headers = headersOf(row);
  return required.every((header) => headers.includes(header));
}

function valueOf(headers: string[], row: CsvRow, header: string): string {
  const index = headers.indexOf(header);
  return index < 0 ? '' : (row.cells[index] ?? '').trim();
}

function bankDate(value: string, field: string): CivilDate {
  const match = /^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/.exec(value.trim());
  if (!match) throw new ImporterError('FORMAT_INVALID', `${field} 不是聯邦銀行民國年日期`);
  return checkedDate(Number(match[1]) + 1911, Number(match[2]), Number(match[3]), field);
}

function transactionDate(value: string, statementDate: CivilDate, field: string): string {
  const match = /^(\d{1,2})\/(\d{1,2})$/.exec(value.trim());
  if (!match) throw new ImporterError('FORMAT_INVALID', `${field} 不是 MM/DD`);
  const month = Number(match[1]);
  const year = month > statementDate.month ? statementDate.year - 1 : statementDate.year;
  return formatCivilDate(checkedDate(year, month, Number(match[2]), field));
}

function checkedDate(year: number, month: number, day: number, field: string): CivilDate {
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  try {
    return parseCivilDate(iso);
  } catch {
    throw new ImporterError('FORMAT_INVALID', `${field} 日期無效`);
  }
}

function cardLast4(value: string): string | undefined {
  return /[－-]\s*(?:正卡|附卡)\s*(\d{4})\s*$/.exec(value)?.[1];
}

function bankAmount(value: string, field: string): bigint {
  try {
    return amountMinor(value, 'TWD');
  } catch {
    throw new ImporterError('FORMAT_INVALID', `${field} 金額格式無效`);
  }
}

function rawRecord(headers: string[], row: CsvRow): Record<string, string> {
  return Object.fromEntries(headers.map((header, index) => [header, row.cells[index] ?? '']));
}

export const unionBankCreditCardImporter: Importer = {
  id: 'union-bank-credit-card',
  displayName: '聯邦銀行信用卡 CSV',
  accepts: ['csv'],
  detect(input) {
    if (input.kind !== 'csv') return 0;
    const sample = input.text.slice(0, 8_192);
    return SUMMARY_HEADERS.every((header) => sample.includes(header)) && DETAIL_HEADERS.every((header) => sample.includes(header)) ? 0.99 : 0;
  },
  async parse(input) {
    if (input.kind !== 'csv') throw new ImporterError('FORMAT_INVALID', 'union-bank-credit-card 只接受 CSV');
    assertInputSize(input.text);
    const rows = parseCsv(input.text, input.delimiter ?? ',');
    const summaryIndex = rows.findIndex((row) => hasHeaders(row, SUMMARY_HEADERS));
    const detailIndex = rows.findIndex((row) => hasHeaders(row, DETAIL_HEADERS));
    if (summaryIndex < 0 || !rows[summaryIndex + 1] || detailIndex < 0) {
      throw new ImporterError('FORMAT_INVALID', '找不到聯邦銀行帳單摘要或交易表頭');
    }

    const summaryHeaders = headersOf(rows[summaryIndex]!);
    const summary = rows[summaryIndex + 1]!;
    const statementDateValue = bankDate(valueOf(summaryHeaders, summary, '帳單結帳日'), '帳單結帳日');
    const statementDate = formatCivilDate(statementDateValue);
    const dueDate = formatCivilDate(bankDate(valueOf(summaryHeaders, summary, '繳款截止日'), '繳款截止日'));
    const totalMinor = bankAmount(valueOf(summaryHeaders, summary, '本期應繳金額'), '本期應繳金額');
    const periodStart = formatCivilDate(addDays(addMonths(statementDateValue, -1), 1));
    const detailHeaders = headersOf(rows[detailIndex]!);
    const warnings: ParseWarning[] = [];
    const transactions: ImportedTransaction[] = [];
    const cardNumbers = new Set<string>();
    let currentCardLast4: string | undefined;
    let printedTotal: bigint | undefined;

    for (const row of rows.slice(detailIndex + 1)) {
      const merchantRaw = valueOf(detailHeaders, row, '消費明細');
      const foundCard = cardLast4(merchantRaw);
      if (foundCard) {
        currentCardLast4 = foundCard;
        cardNumbers.add(foundCard);
        continue;
      }
      if (merchantRaw === '總計') {
        printedTotal = bankAmount(valueOf(detailHeaders, row, '新臺幣金額'), '明細總計');
        break;
      }
      if (merchantRaw === '上期金額' || merchantRaw.includes('上期付款金額已收到')) continue;
      const occurred = valueOf(detailHeaders, row, '消費日');
      const posted = valueOf(detailHeaders, row, '入帳日');
      const amountText = valueOf(detailHeaders, row, '新臺幣金額');
      if (!occurred && !posted && !amountText) continue;

      try {
        if (!merchantRaw || !occurred || !posted || !amountText) throw new ImporterError('FORMAT_INVALID', '交易欄位不完整');
        const amount = amountMinor(amountText, 'TWD');
        const isReward = merchantRaw.includes('回饋');
        transactions.push({
          institution: INSTITUTION,
          merchantRaw,
          amountMinor: amount,
          currency: 'TWD',
          type: isReward ? 'other' : merchantRaw.includes('手續費') ? 'fee' : transactionType(undefined, amount, false),
          occurredAt: transactionDate(occurred, statementDateValue, '消費日'),
          postedAt: transactionDate(posted, statementDateValue, '入帳日'),
          metadata: { line: row.line, raw: rawRecord(detailHeaders, row) },
          ...(currentCardLast4 ? { cardLast4: currentCardLast4 } : {}),
        });
      } catch (error) {
        warnings.push({
          code: 'ROW_SKIPPED',
          line: row.line,
          message: error instanceof Error ? error.message : '無法解析資料列',
          raw: row.cells.join(input.delimiter ?? ','),
        });
      }
    }

    if (transactions.length === 0) throw new ImporterError('FORMAT_INVALID', '聯邦銀行 CSV 沒有可匯入的交易');
    if (transactions.some((transaction) => !transaction.cardLast4)) {
      throw new ImporterError('FORMAT_INVALID', '聯邦銀行交易缺少所屬卡片末四碼，已停止匯入以避免綁錯卡');
    }
    const itemTotal = transactions.reduce((sum, transaction) => sum + transaction.amountMinor, 0n);
    if (printedTotal !== undefined && printedTotal !== itemTotal) {
      warnings.push({ code: 'FIELD_IGNORED', line: rows[detailIndex]!.line, message: '交易加總與 CSV 明細總計不一致，請人工確認' });
    }
    if (itemTotal !== totalMinor) {
      warnings.push({ code: 'FIELD_IGNORED', line: summary.line, message: '交易加總與本期應繳金額不一致，可能含前期未繳或付款調整' });
    }

    return {
      statement: {
        importerId: 'union-bank-credit-card',
        institution: INSTITUTION,
        periodStart,
        periodEnd: statementDate,
        statementDate,
        dueDate,
        totalMinor,
        currency: 'TWD',
        transactions,
        ...(cardNumbers.size === 1 ? { cardLast4: [...cardNumbers][0] } : {}),
      },
      warnings,
    };
  },
};
