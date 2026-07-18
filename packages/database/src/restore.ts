import { eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { type Db } from './client.js';
import {
  accountGroups,
  accounts,
  auditCandidates,
  auditLogs,
  auditSessions,
  creditCards,
  creditLimitGroups,
  exchangeRates,
  expectedTransactions,
  holdings,
  importFiles,
  investmentAccounts,
  journalEntries,
  journalLines,
  marketPrices,
  merchantAliases,
  notificationLog,
  notificationPreferences,
  proposedPatches,
  recurringRules,
  securities,
  statementItems,
  statementGroups,
  statements,
  syncMutations,
  transactionLinks,
  transactions,
} from './schema.js';

/**
 * 匯入完整備份（F10 的另一半：資料所有權要能帶走，也要能帶回來）。
 *
 * 這是 domain service 之外唯一的帳本寫入路徑——寫入的是「當初已經過 domain 驗證」
 * 的匯出資料，原樣還原；入庫前逐 journal entry 重新驗證平衡，整包單一交易，
 * 全成功或全不動。只允許還原到未動過的帳本（無交易、無 journal、無帳單）。
 */

export class RestoreError extends Error {
  constructor(
    readonly code: 'LEDGER_NOT_EMPTY' | 'IMPORT_INVALID' | 'IMPORT_UNBALANCED',
    message: string,
  ) {
    super(message);
  }
}

/** 還原順序（依外鍵相依排列）；key 對應 exportAllData 的輸出鍵名 */
const RESTORE_TABLES: ReadonlyArray<{ key: string; table: PgTable }> = [
  { key: 'account_groups', table: accountGroups },
  { key: 'credit_limit_groups', table: creditLimitGroups },
  { key: 'accounts', table: accounts },
  { key: 'credit_cards', table: creditCards },
  { key: 'audit_logs', table: auditLogs },
  { key: 'securities', table: securities },
  { key: 'market_prices', table: marketPrices },
  { key: 'investment_accounts', table: investmentAccounts },
  { key: 'holdings', table: holdings },
  { key: 'import_files', table: importFiles },
  { key: 'statement_groups', table: statementGroups },
  { key: 'statements', table: statements },
  { key: 'transactions', table: transactions },
  { key: 'statement_items', table: statementItems },
  { key: 'journal_entries', table: journalEntries },
  { key: 'journal_lines', table: journalLines },
  { key: 'transaction_links', table: transactionLinks },
  { key: 'recurring_rules', table: recurringRules },
  { key: 'expected_transactions', table: expectedTransactions },
  { key: 'audit_sessions', table: auditSessions },
  { key: 'audit_candidates', table: auditCandidates },
  { key: 'proposed_patches', table: proposedPatches },
  { key: 'merchant_aliases', table: merchantAliases },
  { key: 'sync_mutations', table: syncMutations },
  { key: 'notification_preferences', table: notificationPreferences },
  { key: 'notification_log', table: notificationLog },
];

/**
 * 不還原的表與原因：
 * - change_log：seq 是伺服器本地的 bigserial 同步游標，還原會弄壞新伺服器的 change feed；client 重新全量同步即可
 * - sync_devices：裝置註冊綁定實體裝置，新環境重新註冊
 * - jobs：暫態工作佇列，還原可能觸發過期的排程工作
 * - discord_links：綁定舊環境的 Discord application，新環境重新連結
 * - web_push_subscriptions：推播訂閱綁定瀏覽器與舊環境的 VAPID 金鑰，必然失效
 */
const SKIPPED_TABLES = ['change_log', 'sync_devices', 'jobs', 'discord_links', 'web_push_subscriptions'] as const;

export interface RestoreSummary {
  imported: Record<string, number>;
  skippedTables: string[];
}

/** 依欄位型別把 JSON 匯出值轉回 DB 型別（timestamp → Date、bigint 欄 → BigInt）；user_id 一律覆寫成目前使用者 */
function coerceRows(table: PgTable, rows: Array<Record<string, unknown>>, userId: string): Array<Record<string, unknown>> {
  const columns = getTableColumns(table);
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(columns)) {
      if (key === 'userId') {
        out[key] = userId;
        continue;
      }
      if (!(key in row)) continue;
      const value = row[key];
      if (value === null || value === undefined) {
        out[key] = null;
      } else if (column.dataType === 'date') {
        out[key] = new Date(value as string);
      } else if (column.dataType === 'bigint') {
        out[key] = BigInt(value as string | number);
      } else {
        out[key] = value;
      }
    }
    return out;
  });
}

/** 帳務不變量：每個 journal entry 分幣別加總必須為 0（借正貸負），不平衡整包拒收 */
function assertJournalBalanced(entries: Array<Record<string, unknown>>, lines: Array<Record<string, unknown>>): void {
  const entryIds = new Set(entries.map((entry) => entry['id'] as string));
  const sums = new Map<string, bigint>();
  for (const line of lines) {
    const entryId = line['entryId'] as string;
    if (!entryIds.has(entryId)) {
      throw new RestoreError('IMPORT_INVALID', '備份檔內有 journal line 指向不存在的 entry，檔案不完整');
    }
    const key = `${entryId}|${line['currency'] as string}`;
    sums.set(key, (sums.get(key) ?? 0n) + BigInt(line['amountMinor'] as string));
  }
  for (const [key, sum] of sums) {
    if (sum !== 0n) {
      throw new RestoreError('IMPORT_UNBALANCED', `備份檔內有不平衡的 journal entry（${key.split('|')[0] ?? ''}），拒絕匯入`);
    }
  }
}

export async function restoreAllData(
  db: Db,
  userId: string,
  data: Record<string, unknown>,
  importAuditLogId: string,
): Promise<RestoreSummary> {
  const rowsOf = (key: string): Array<Record<string, unknown>> => {
    const value = data[key];
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new RestoreError('IMPORT_INVALID', `備份檔的 ${key} 不是清單，檔案格式不對`);
    return value as Array<Record<string, unknown>>;
  };

  const countOf = async (table: typeof transactions | typeof journalEntries | typeof statements): Promise<number> => {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(table.userId, userId));
    return row?.n ?? 0;
  };
  if ((await countOf(transactions)) || (await countOf(journalEntries)) || (await countOf(statements))) {
    throw new RestoreError('LEDGER_NOT_EMPTY', '這個帳號已經有帳務資料，匯入備份只能在還沒記帳的全新帳號上執行');
  }

  assertJournalBalanced(rowsOf('journal_entries'), rowsOf('journal_lines'));

  return await db.transaction(async (tx) => {
    // 清掉註冊時自動建立的預設分類與期初帳戶（前置檢查保證它們沒有任何 journal 參照），
    // 以備份內容原樣取代，避免出現兩套預設分類。audit_logs 保留（含註冊與本次匯入的紀錄）。
    const ownAccountIds = tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, userId));
    const ownSecurityIds = tx.select({ id: securities.id }).from(securities).where(eq(securities.userId, userId));
    await tx.delete(expectedTransactions).where(eq(expectedTransactions.userId, userId));
    await tx.delete(recurringRules).where(eq(recurringRules.userId, userId));
    await tx.delete(holdings).where(eq(holdings.userId, userId));
    await tx.delete(investmentAccounts).where(eq(investmentAccounts.userId, userId));
    await tx.delete(marketPrices).where(inArray(marketPrices.securityId, ownSecurityIds));
    await tx.delete(securities).where(eq(securities.userId, userId));
    await tx.delete(creditCards).where(inArray(creditCards.accountId, ownAccountIds));
    await tx.delete(merchantAliases).where(eq(merchantAliases.userId, userId));
    await tx.delete(accounts).where(eq(accounts.userId, userId));
    await tx.delete(accountGroups).where(eq(accountGroups.userId, userId));
    await tx.delete(creditLimitGroups).where(eq(creditLimitGroups.userId, userId));
    await tx.delete(notificationPreferences).where(eq(notificationPreferences.userId, userId));

    const imported: Record<string, number> = {};
    for (const { key, table } of RESTORE_TABLES) {
      const rows = coerceRows(table, rowsOf(key), userId);
      imported[key] = rows.length;
      for (let i = 0; i < rows.length; i += 500) {
        await tx.insert(table).values(rows.slice(i, i + 500) as never);
      }
    }

    // 匯率是共用表（無 user_id）：同 id 已存在就跳過，不覆寫
    const rateRows = coerceRows(exchangeRates, rowsOf('exchange_rates'), userId);
    for (let i = 0; i < rateRows.length; i += 500) {
      await tx.insert(exchangeRates).values(rateRows.slice(i, i + 500) as never).onConflictDoNothing();
    }
    imported['exchange_rates'] = rateRows.length;

    // 匯入行為本身留 audit log（誰、何時、還原了多少筆）
    await tx.insert(auditLogs).values({
      id: importAuditLogId,
      userId,
      actor: 'user',
      entity: 'ledger',
      entityId: importAuditLogId,
      action: 'import',
      before: null,
      after: imported,
      mutationId: null,
    });

    return { imported, skippedTables: [...SKIPPED_TABLES] };
  });
}
