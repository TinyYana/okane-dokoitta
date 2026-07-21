import { addMonths, compareCivilDates, formatCivilDate, parseCivilDate, type CivilDate } from '@okane-dokoitta/domain';
import { amountMinor, assertInputSize, transactionType } from '../shared.js';
import { ImporterError, type ImportedTransaction, type Importer, type ParseWarning } from '../types.js';

const INSTITUTION = '國泰世華銀行';

/** 帳單日／繳款截止日／應繳總額／最低應繳金額：民國年帳單日 民國年繳款日 應繳總額 最低應繳（例：115/07/19 115/08/02 4,184 1,000）。 */
const HEADER_RE = /(\d{3})\/(\d{2})\/(\d{2})\s+(\d{3})\/(\d{2})\/(\d{2})\s+([\d,]+)\s+[\d,]+/;

/**
 * 交易明細行：消費日 入帳/起息日 商家 金額 [卡號末四碼 [行動卡號末四碼] 消費國家 幣別]。
 * 末四碼／國家／幣別整組是選用的——繳款、上期調整這類行沒有這些欄位，只有日期＋商家＋金額。
 * 「上期帳單總額」「繳款小計」「正卡本期消費」「本期應繳總額」這些摘要行前面沒有兩個日期，天然不會被這個
 * pattern 吃到，不需要另外用關鍵字排除。
 * 日期一定是零填滿的兩位數（06/15、07/09），商家欄不跨行——避免頁碼「2/3」、頁尾裝訂碼跟隨頁與頁間的
 * 亂碼被誤湊成一筆假交易（曾經在真實帳單上重現過：頁尾「VZ000013-TW-03/18 2/3」+ 二進位垃圾字元）。
 */
const ROW_RE = /(\d{2})\/(\d{2})\s+(\d{2})\/(\d{2})\s+([^\d\n]+?)\s+(-?[\d,]+)(?:\s+(\d{4})(?:\s+(\d{4}))?\s+([A-Z]{2})\s+([A-Z]{3}))?/g;

function rocDate(year3: string, month: string, day: string, field: string): CivilDate {
  try {
    return parseCivilDate(`${Number(year3) + 1911}-${month}-${day}`);
  } catch {
    throw new ImporterError('FORMAT_INVALID', `${field} 日期無效`);
  }
}

/** MM/DD 沒有年份，依帳單日推斷西元年：月份比帳單月大代表是上一年（例如 12 月消費、隔年 1 月出帳）。 */
function shortDate(month: string, day: string, statementDate: CivilDate, field: string): string {
  const m = Number(month);
  const year = m > statementDate.month ? statementDate.year - 1 : statementDate.year;
  try {
    return formatCivilDate(parseCivilDate(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`));
  } catch {
    throw new ImporterError('FORMAT_INVALID', `${field} 日期無效`);
  }
}

export const cathayCreditCardImporter: Importer = {
  id: 'cathay-credit-card',
  displayName: '國泰世華信用卡電子帳單',
  accepts: ['text', 'pdf'],
  detect(input) {
    if (input.kind !== 'text' && input.kind !== 'pdf') return 0;
    const text = (input.kind === 'pdf' ? input.extractedText : input.text).slice(0, 20_000);
    const hasBank = text.includes('國泰世華') || text.includes('cathaybk');
    const hasStatementShape = text.includes('信用卡帳單') && text.includes('本期應繳總額') && HEADER_RE.test(text);
    return hasBank && hasStatementShape ? 0.95 : 0;
  },
  async parse(input) {
    if (input.kind !== 'text' && input.kind !== 'pdf') throw new ImporterError('FORMAT_INVALID', 'cathay-credit-card 只接受文字或 PDF 抽出的文字');
    const text = input.kind === 'pdf' ? input.extractedText : input.text;
    assertInputSize(text);

    const header = HEADER_RE.exec(text);
    if (!header) throw new ImporterError('FORMAT_INVALID', '找不到國泰世華帳單的帳單日／繳款截止日／應繳總額');
    const statementDateValue = rocDate(header[1]!, header[2]!, header[3]!, '帳單日');
    const statementDate = formatCivilDate(statementDateValue);
    const dueDate = formatCivilDate(rocDate(header[4]!, header[5]!, header[6]!, '繳款截止日'));
    const totalMinor = amountMinor(header[7]!, 'TWD');

    const warnings: ParseWarning[] = [];
    const transactions: ImportedTransaction[] = [];
    const cardNumbers = new Set<string>();
    let earliest: CivilDate | undefined;

    for (const match of text.matchAll(ROW_RE)) {
      const [, occMonth, occDay, postMonth, postDay, merchantRaw, amountText, last4, , , currency] = match;
      const merchant = merchantRaw!.trim();
      if (!merchant) continue;
      try {
        const amount = amountMinor(amountText!, 'TWD');
        const occurredAt = shortDate(occMonth!, occDay!, statementDateValue, '消費日');
        const isPayment = merchant.includes('繳款') || merchant.includes('ATM') || merchant.includes('ＡＴＭ');
        transactions.push({
          institution: INSTITUTION,
          merchantRaw: merchant,
          amountMinor: amount,
          currency: currency ?? 'TWD',
          type: isPayment ? 'payment' : transactionType(undefined, amount, false),
          occurredAt,
          postedAt: shortDate(postMonth!, postDay!, statementDateValue, '入帳／起息日'),
          metadata: { raw: match[0] },
          ...(last4 ? { cardLast4: last4 } : {}),
        });
        if (last4) cardNumbers.add(last4);
        const occurredCivil = parseCivilDate(occurredAt);
        if (!earliest || compareCivilDates(occurredCivil, earliest) < 0) earliest = occurredCivil;
      } catch (error) {
        warnings.push({ code: 'ROW_SKIPPED', line: 0, message: error instanceof Error ? error.message : '無法解析資料列', raw: match[0] });
      }
    }

    if (transactions.length === 0) throw new ImporterError('FORMAT_INVALID', '國泰世華帳單沒有可匯入的交易');
    const itemTotal = transactions.reduce((sum, transaction) => sum + transaction.amountMinor, 0n);
    if (itemTotal !== totalMinor) {
      warnings.push({ code: 'FIELD_IGNORED', line: 0, message: '交易加總與本期應繳總額不一致，可能含前期未繳或付款調整，請人工確認' });
    }
    // 沒有明講帳單期間；用帳單裡最早一筆消費日當起點，帳單日當迄日（帳單日通常比最後一筆消費晚幾天結帳）
    const periodStart = formatCivilDate(earliest ?? addMonths(statementDateValue, -1));

    return {
      statement: {
        importerId: 'cathay-credit-card',
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
