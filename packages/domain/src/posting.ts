import { assertUsableAccount, type AccountInfo } from './accounts.js';
import { currencyExponent } from './currency.js';
import { civilDateFromInstant, formatCivilDate } from './dates.js';
import { DomainError } from './errors.js';
import type { TransactionInput, TransactionLinkKind } from './transactions.js';

/**
 * Posting rules（DATA_MODEL §3.4、ADR-001）。
 *
 * 符號規約（本檔案是唯一定義處，以測試釘死；文件的正負表僅描述「增減語意」）：
 *   amount_minor 正 = 借方（debit）、負 = 貸方（credit）。
 *   資產與費用「增加」記正；負債、收入與 equity「增加」記負。
 *   ⇒ 每個 entry 內每個幣別 lines 總和恆為 0（不變量 I-2）。
 *
 * 不變量：
 *   I-1 每 entry ≥ 2 lines
 *   I-2 每幣別總和 = 0
 *   I-3 跨幣別交易拆成兩個同幣別 entry（= 兩筆 transaction）以 fx_pair 連結
 *   I-4 lines 只能由這裡的 posting rules 產生，不可被 API 直接寫入
 */

export interface JournalLineDraft {
  accountId: string;
  amountMinor: bigint;
  currency: string;
}

export interface JournalEntryDraft {
  entryDate: string; // YYYY-MM-DD（帳本時區的民用日期）
  description: string;
  lines: JournalLineDraft[];
}

export interface TransactionLinkDraft {
  kind: TransactionLinkKind;
  fromTransactionId: string;
  toTransactionId: string;
  metadata?: Record<string, string>;
}

export interface PostingResult {
  entry: JournalEntryDraft;
  links: TransactionLinkDraft[];
}

function getAccount(accounts: ReadonlyMap<string, AccountInfo>, id: string | undefined, role: string): AccountInfo {
  if (!id) throw new DomainError('ACCOUNT_NOT_FOUND', `缺少${role}帳戶`);
  const account = accounts.get(id);
  if (!account) throw new DomainError('ACCOUNT_NOT_FOUND', `找不到${role}帳戶: ${id}`);
  assertUsableAccount(account);
  return account;
}

function assertCurrency(account: AccountInfo, currency: string, role: string): void {
  // opening_balance equity 允許任意幣別 line：單一 equity 帳戶要同時
  // 承接各幣別帳戶的期初餘額與跨幣別 pair 的平衡端。
  if (account.subtype === 'opening_balance') return;
  if (account.currency !== currency) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      `${role}帳戶幣別 ${account.currency} 與交易幣別 ${currency} 不一致`,
    );
  }
}

function assertKind(account: AccountInfo, allowed: readonly string[], role: string, check: (a: AccountInfo) => boolean): void {
  if (!check(account)) {
    throw new DomainError('ACCOUNT_KIND_INVALID', `${role}帳戶（${account.kind}/${account.subtype}）不允許，需要: ${allowed.join('|')}`);
  }
}

/** 驗證後自我檢查：I-1、I-2。任何 posting rule 的輸出都必須通過。 */
export function assertEntryInvariants(entry: JournalEntryDraft): void {
  if (entry.lines.length < 2) {
    throw new DomainError('ENTRY_TOO_FEW_LINES', `entry 至少 2 條 lines，只有 ${entry.lines.length}`);
  }
  const sums = new Map<string, bigint>();
  for (const line of entry.lines) {
    currencyExponent(line.currency);
    sums.set(line.currency, (sums.get(line.currency) ?? 0n) + line.amountMinor);
  }
  for (const [currency, sum] of sums) {
    if (sum !== 0n) {
      throw new DomainError('ENTRY_UNBALANCED', `entry 幣別 ${currency} 總和 ${sum} ≠ 0`);
    }
  }
}

/**
 * 由交易產生平衡的 journal entry（唯一入口，I-4）。
 * 回傳 entry 與必要的 transaction links（refund 必附 link）。
 */
export function buildPosting(
  txn: TransactionInput,
  accounts: ReadonlyMap<string, AccountInfo>,
  ledgerTimeZone?: string,
): PostingResult {
  if (txn.amountMinor <= 0n) {
    throw new DomainError('AMOUNT_NOT_POSITIVE', `交易金額必須為正: ${txn.amountMinor}`);
  }
  currencyExponent(txn.currency);

  const n = txn.amountMinor;
  const currency = txn.currency;
  const entryDate = formatCivilDate(civilDateFromInstant(txn.occurredAt, ledgerTimeZone));
  const description = txn.note ?? txn.merchantRaw ?? txn.type;
  const links: TransactionLinkDraft[] = [];
  let lines: JournalLineDraft[];

  switch (txn.type) {
    case 'expense':
    case 'fee':
    case 'tax': {
      // 支出：分類(expense) +n；資金來源（資產或信用卡負債） −n
      const from = getAccount(accounts, txn.fromAccountId, '支出來源');
      const category = getAccount(accounts, txn.categoryAccountId, '分類');
      assertKind(from, ['asset', 'credit_card'], '支出來源', (a) => a.kind === 'asset' || a.subtype === 'credit_card');
      assertKind(category, ['category_expense'], '分類', (a) => a.subtype === 'category_expense');
      assertCurrency(from, currency, '支出來源');
      assertCurrency(category, currency, '分類');
      lines = [
        { accountId: category.id, amountMinor: n, currency },
        { accountId: from.id, amountMinor: -n, currency },
      ];
      break;
    }
    case 'income': {
      // 收入：資產增加或信用卡負債減少 +n；分類(income) −n
      const to = getAccount(accounts, txn.toAccountId, '入帳');
      const category = getAccount(accounts, txn.categoryAccountId, '分類');
      assertKind(to, ['asset', 'credit_card'], '入帳', (a) => a.kind === 'asset' || a.subtype === 'credit_card');
      assertKind(category, ['category_income'], '分類', (a) => a.subtype === 'category_income');
      assertCurrency(to, currency, '入帳');
      assertCurrency(category, currency, '分類');
      lines = [
        { accountId: to.id, amountMinor: n, currency },
        { accountId: category.id, amountMinor: -n, currency },
      ];
      break;
    }
    case 'transfer': {
      // 轉帳（TXN-5）：單一交易兩條 lines；跨幣別走 planCrossCurrencyPair
      const from = getAccount(accounts, txn.fromAccountId, '轉出');
      const to = getAccount(accounts, txn.toAccountId, '轉入');
      assertKind(from, ['asset'], '轉出', (a) => a.kind === 'asset');
      assertKind(to, ['asset', 'liability'], '轉入', (a) => a.kind === 'asset' || a.kind === 'liability');
      if (to.subtype === 'credit_card') {
        throw new DomainError('TRANSACTION_TYPE_INVALID', '轉入信用卡請用 card_payment（繳款語意）');
      }
      assertCurrency(from, currency, '轉出');
      assertCurrency(to, currency, '轉入');
      lines = [
        { accountId: to.id, amountMinor: n, currency },
        { accountId: from.id, amountMinor: -n, currency },
      ];
      break;
    }
    case 'card_payment': {
      // 信用卡繳款＝轉帳（銀行資產↓、卡負債↓）。硬規則：不產生 expense line。
      const from = getAccount(accounts, txn.fromAccountId, '付款');
      const card = getAccount(accounts, txn.toAccountId, '信用卡');
      assertKind(from, ['asset'], '付款', (a) => a.kind === 'asset');
      assertKind(card, ['credit_card'], '信用卡', (a) => a.subtype === 'credit_card');
      assertCurrency(from, currency, '付款');
      assertCurrency(card, currency, '信用卡');
      lines = [
        { accountId: card.id, amountMinor: n, currency }, // 負債減少 = 借方
        { accountId: from.id, amountMinor: -n, currency },
      ];
      break;
    }
    case 'refund': {
      // 退款：原分錄反向，必須 link 原交易（硬規則）
      if (!txn.originalTransactionId) {
        throw new DomainError('REFUND_MISSING_LINK', '退款必須連結原始交易');
      }
      const to = getAccount(accounts, txn.toAccountId, '退款入帳');
      const category = getAccount(accounts, txn.categoryAccountId, '原分類');
      assertKind(to, ['asset', 'credit_card'], '退款入帳', (a) => a.kind === 'asset' || a.subtype === 'credit_card');
      assertKind(category, ['category_expense'], '原分類', (a) => a.subtype === 'category_expense');
      assertCurrency(to, currency, '退款入帳');
      assertCurrency(category, currency, '原分類');
      lines = [
        { accountId: to.id, amountMinor: n, currency },
        { accountId: category.id, amountMinor: -n, currency },
      ];
      links.push({ kind: 'refund', fromTransactionId: txn.originalTransactionId, toTransactionId: txn.id });
      break;
    }
    case 'invest_buy': {
      // 投資買入＝資產轉換（交割現金↓、投資資產↑）。硬規則：不產生 expense line。
      const settlement = getAccount(accounts, txn.fromAccountId, '交割');
      const asset = getAccount(accounts, txn.toAccountId, '投資資產');
      assertKind(settlement, ['asset'], '交割', (a) => a.kind === 'asset');
      assertKind(asset, ['investment_asset'], '投資資產', (a) => a.subtype === 'investment_asset');
      assertCurrency(settlement, currency, '交割');
      assertCurrency(asset, currency, '投資資產');
      lines = [
        { accountId: asset.id, amountMinor: n, currency },
        { accountId: settlement.id, amountMinor: -n, currency },
      ];
      break;
    }
    case 'invest_sell': {
      // 賣出：交割 +賣出額；投資資產 −成本；差額入已實現損益分類（Q11：正負皆同一分類）
      const settlement = getAccount(accounts, txn.toAccountId, '交割');
      const asset = getAccount(accounts, txn.fromAccountId, '投資資產');
      assertKind(settlement, ['asset'], '交割', (a) => a.kind === 'asset');
      assertKind(asset, ['investment_asset'], '投資資產', (a) => a.subtype === 'investment_asset');
      assertCurrency(settlement, currency, '交割');
      assertCurrency(asset, currency, '投資資產');
      const cost = txn.costBasisMinor ?? n;
      if (cost <= 0n) throw new DomainError('AMOUNT_NOT_POSITIVE', '成本基礎必須為正');
      lines = [
        { accountId: settlement.id, amountMinor: n, currency },
        { accountId: asset.id, amountMinor: -cost, currency },
      ];
      const pnl = n - cost;
      if (pnl !== 0n) {
        const category = getAccount(accounts, txn.categoryAccountId, '已實現損益分類');
        assertKind(category, ['category_income'], '已實現損益分類', (a) => a.subtype === 'category_income');
        assertCurrency(category, currency, '已實現損益分類');
        lines.push({ accountId: category.id, amountMinor: -pnl, currency });
      }
      break;
    }
    case 'dividend': {
      // 股息：交割 +n；股息收入分類 −n（不得計為賣出或一般收入以外的東西）
      const settlement = getAccount(accounts, txn.toAccountId, '交割');
      const category = getAccount(accounts, txn.categoryAccountId, '股息分類');
      assertKind(settlement, ['asset'], '交割', (a) => a.kind === 'asset');
      assertKind(category, ['category_income'], '股息分類', (a) => a.subtype === 'category_income');
      assertCurrency(settlement, currency, '交割');
      assertCurrency(category, currency, '股息分類');
      lines = [
        { accountId: settlement.id, amountMinor: n, currency },
        { accountId: category.id, amountMinor: -n, currency },
      ];
      break;
    }
    case 'adjustment': {
      // 期初餘額與修正：to +n、from −n（from 通常是 opening_balance equity）
      const from = getAccount(accounts, txn.fromAccountId, '調整來源');
      const to = getAccount(accounts, txn.toAccountId, '調整對象');
      assertCurrency(from, currency, '調整來源');
      assertCurrency(to, currency, '調整對象');
      lines = [
        { accountId: to.id, amountMinor: n, currency },
        { accountId: from.id, amountMinor: -n, currency },
      ];
      break;
    }
    default: {
      throw new DomainError('TRANSACTION_TYPE_INVALID', `未知交易類型: ${String(txn.type)}`);
    }
  }

  const entry: JournalEntryDraft = { entryDate, description, lines };
  assertEntryInvariants(entry);
  return { entry, links };
}

/**
 * 跨幣別交易（I-3）：拆成兩筆同幣別交易 + fx_pair link。
 * 轉出側（from 幣別）與轉入側（to 幣別）各是一筆 adjustment 形狀的同幣別平衡 entry，
 * 兩側都以 opening_balance equity 帳戶作平衡端，link metadata 記錄成交匯率。
 * M1 只在 model 層提供（TXN-7）；UI 於 M4 匯率一覽時串接。
 */
export function planCrossCurrencyPair(params: {
  fromTransactionId: string;
  toTransactionId: string;
  rate: string; // 1 from 主單位 = rate to 主單位（記錄用）
}): TransactionLinkDraft {
  return {
    kind: 'fx_pair',
    fromTransactionId: params.fromTransactionId,
    toTransactionId: params.toTransactionId,
    metadata: { rate: params.rate },
  };
}
