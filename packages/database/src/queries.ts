import {
  addDays,
  computeCardCycle,
  computeMarketValueMinor,
  computePreviousCardCycle,
  convert,
  formatCivilDate,
  formatQuantity,
  type CivilDate,
} from '@okane-dokoitta/domain';
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { type Db } from './client.js';
import {
  accountGroups,
  accounts,
  auditLogs,
  auditCandidates,
  auditSessions,
  changeLog,
  creditCards,
  creditLimitGroups,
  discordLinks,
  exchangeRates,
  expectedTransactions,
  holdings,
  investmentAccounts,
  journalEntries,
  journalLines,
  importFiles,
  jobs,
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
  syncDevices,
  syncMutations,
  transactionLinks,
  transactions,
  webPushSubscriptions,
} from './schema.js';

/**
 * 讀取層。所有查詢一律以 user_id 界定（AGENTS §7）。
 * 餘額永遠是 journal_lines 的加總（借正貸負），不是欄位。
 */

export async function accountBalances(db: Db, userId: string): Promise<Map<string, bigint>> {
  const rows = await db
    .select({
      accountId: journalLines.accountId,
      balance: sql<string>`coalesce(sum(${journalLines.amountMinor}), 0)::text`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(and(eq(journalEntries.userId, userId), isNull(journalEntries.deletedAt)))
    .groupBy(journalLines.accountId);
  return new Map(rows.map((r) => [r.accountId, BigInt(r.balance)]));
}

export async function listAccounts(db: Db, userId: string) {
  const rows = await db
    .select({ account: accounts, creditCard: creditCards })
    .from(accounts)
    .leftJoin(creditCards, eq(creditCards.accountId, accounts.id))
    .where(and(eq(accounts.userId, userId), isNull(accounts.deletedAt)))
    .orderBy(accounts.createdAt);
  const balances = await accountBalances(db, userId);
  return rows.map((r) => ({
    ...r.account,
    balanceMinor: balances.get(r.account.id) ?? 0n,
    creditCard: r.creditCard,
  }));
}

export async function listAccountGroups(db: Db, userId: string) {
  return db
    .select()
    .from(accountGroups)
    .where(and(eq(accountGroups.userId, userId), isNull(accountGroups.deletedAt)))
    .orderBy(accountGroups.sortOrder);
}

export async function listLimitGroups(db: Db, userId: string) {
  return db
    .select()
    .from(creditLimitGroups)
    .where(and(eq(creditLimitGroups.userId, userId), isNull(creditLimitGroups.deletedAt)))
    .orderBy(creditLimitGroups.createdAt);
}

export interface TransactionListFilter {
  limit: number;
  /** 游標：occurredAt ISO；取「更早」的資料 */
  before?: string | undefined;
  accountId?: string | undefined;
}

export async function listTransactions(db: Db, userId: string, filter: TransactionListFilter) {
  const conds = [eq(transactions.userId, userId), isNull(transactions.deletedAt)];
  if (filter.before) conds.push(lte(transactions.occurredAt, new Date(filter.before)));
  if (filter.accountId) {
    conds.push(
      or(
        eq(transactions.fromAccountId, filter.accountId),
        eq(transactions.toAccountId, filter.accountId),
        eq(transactions.categoryAccountId, filter.accountId),
      )!,
    );
  }
  return db
    .select()
    .from(transactions)
    .where(and(...conds))
    .orderBy(desc(transactions.occurredAt), desc(transactions.id))
    .limit(filter.limit);
}

/** 卡在期間內的消費/退款合計（entry_date = 帳本時區民用日期） */
async function cardPeriodSums(
  db: Db,
  userId: string,
  cardAccountId: string,
  from: CivilDate,
  to: CivilDate,
): Promise<{ postedMinor: bigint; pendingMinor: bigint; refundedMinor: bigint }> {
  const rows = await db
    .select({
      type: transactions.type,
      status: transactions.status,
      total: sql<string>`coalesce(sum(${transactions.amountMinor}), 0)::text`,
    })
    .from(transactions)
    .innerJoin(journalEntries, eq(journalEntries.transactionId, transactions.id))
    .where(
      and(
        eq(transactions.userId, userId),
        isNull(transactions.deletedAt),
        isNull(journalEntries.deletedAt),
        gte(journalEntries.entryDate, formatCivilDate(from)),
        lte(journalEntries.entryDate, formatCivilDate(to)),
        inArray(transactions.status, ['pending', 'posted']),
        or(
          and(eq(transactions.fromAccountId, cardAccountId), inArray(transactions.type, ['expense', 'fee', 'tax'])),
          and(eq(transactions.toAccountId, cardAccountId), eq(transactions.type, 'refund')),
        )!,
      ),
    )
    .groupBy(transactions.type, transactions.status);

  let postedMinor = 0n;
  let pendingMinor = 0n;
  let refundedMinor = 0n;
  for (const r of rows) {
    const v = BigInt(r.total);
    if (r.type === 'refund') refundedMinor += v;
    else if (r.status === 'posted') postedMinor += v;
    else pendingMinor += v;
  }
  return { postedMinor, pendingMinor, refundedMinor };
}

/** 信用卡週期視圖（ACCT-5）：全部由 transactions + journal 推導，不是儲存欄位。 */
export async function cardCycleView(db: Db, userId: string, cardAccountId: string, today: CivilDate) {
  const [row] = await db
    .select({ account: accounts, card: creditCards })
    .from(accounts)
    .innerJoin(creditCards, eq(creditCards.accountId, accounts.id))
    .where(and(eq(accounts.id, cardAccountId), eq(accounts.userId, userId), isNull(accounts.deletedAt)))
    .limit(1);
  if (!row) return null;
  const { account, card } = row;

  const current = computeCardCycle(card.statementDay, card.dueDay, today);
  const previous = computePreviousCardCycle(card.statementDay, card.dueDay, today);

  const currentSums = await cardPeriodSums(db, userId, cardAccountId, current.periodStart, current.periodEnd);
  const prevSums = await cardPeriodSums(db, userId, cardAccountId, previous.periodStart, previous.periodEnd);

  // 上期已繳：結帳日之後付進這張卡的 card_payment 合計
  // ponytail: 繳款不分期別歸屬（單卡單期的簡化）；M3 statements 落地後改按 payment_for_statement link 歸屬
  const [paidRow] = await db
    .select({ total: sql<string>`coalesce(sum(${transactions.amountMinor}), 0)::text` })
    .from(transactions)
    .innerJoin(journalEntries, eq(journalEntries.transactionId, transactions.id))
    .where(
      and(
        eq(transactions.userId, userId),
        isNull(transactions.deletedAt),
        isNull(journalEntries.deletedAt),
        eq(transactions.type, 'card_payment'),
        eq(transactions.toAccountId, cardAccountId),
        sql`${journalEntries.entryDate} > ${formatCivilDate(previous.statementDate)}`,
      ),
    );
  const paidMinor = BigInt(paidRow?.total ?? '0');
  const prevTotal = prevSums.postedMinor + prevSums.pendingMinor - prevSums.refundedMinor;
  const unpaid = prevTotal - paidMinor;

  // 卡目前總負債 = −(lines 加總)（負債貸方為負）
  const balances = await accountBalances(db, userId);
  const outstanding = -(balances.get(cardAccountId) ?? 0n);

  // 可用額度：共用群組 → 群組上限 − 群組內所有卡負債；獨立 → 卡上限 − 卡負債
  let availableCreditMinor: bigint | null = null;
  if (card.limitGroupId) {
    const [group] = await db
      .select()
      .from(creditLimitGroups)
      .where(and(eq(creditLimitGroups.id, card.limitGroupId), eq(creditLimitGroups.userId, userId), isNull(creditLimitGroups.deletedAt)))
      .limit(1);
    if (group) {
      const groupCards = await db
        .select({ accountId: creditCards.accountId })
        .from(creditCards)
        .innerJoin(accounts, eq(creditCards.accountId, accounts.id))
        .where(and(eq(creditCards.limitGroupId, group.id), eq(accounts.userId, userId), isNull(accounts.deletedAt)));
      let groupOutstanding = 0n;
      for (const gc of groupCards) groupOutstanding += -(balances.get(gc.accountId) ?? 0n);
      availableCreditMinor = group.limitMinor - groupOutstanding;
    }
  } else if (card.creditLimitMinor !== null) {
    availableCreditMinor = card.creditLimitMinor - outstanding;
  }

  return {
    accountId: cardAccountId,
    currency: account.currency,
    current: {
      periodStart: formatCivilDate(current.periodStart),
      periodEnd: formatCivilDate(current.periodEnd),
      statementDate: formatCivilDate(current.statementDate),
      dueDate: formatCivilDate(current.dueDate),
      postedMinor: currentSums.postedMinor,
      pendingMinor: currentSums.pendingMinor,
      refundedMinor: currentSums.refundedMinor,
    },
    previous: {
      periodStart: formatCivilDate(previous.periodStart),
      periodEnd: formatCivilDate(previous.periodEnd),
      statementDate: formatCivilDate(previous.statementDate),
      dueDate: formatCivilDate(previous.dueDate),
      totalMinor: prevTotal,
      paidMinor,
      unpaidMinor: unpaid > 0n ? unpaid : 0n,
    },
    outstandingMinor: outstanding,
    availableCreditMinor,
  };
}

export async function listRecurringRules(db: Db, userId: string) {
  return db
    .select()
    .from(recurringRules)
    .where(and(eq(recurringRules.userId, userId), isNull(recurringRules.deletedAt)))
    .orderBy(recurringRules.nextExpectedDate);
}

/** 待處理的預計交易：scheduled / matched / missed（F5 待確認清單） */
export async function listOpenExpected(db: Db, userId: string) {
  return db
    .select()
    .from(expectedTransactions)
    .where(
      and(
        eq(expectedTransactions.userId, userId),
        isNull(expectedTransactions.deletedAt),
        inArray(expectedTransactions.status, ['scheduled', 'matched', 'missed']),
      ),
    )
    .orderBy(expectedTransactions.expectedDate);
}

// ---------- 投資與淨資產一覽（M4，INVESTMENT_MODEL） ----------

export async function listInvestmentAccounts(db: Db, userId: string) {
  return db
    .select()
    .from(investmentAccounts)
    .where(and(eq(investmentAccounts.userId, userId), isNull(investmentAccounts.deletedAt)))
    .orderBy(investmentAccounts.createdAt);
}

export async function listSecurities(db: Db, userId: string) {
  return db
    .select()
    .from(securities)
    .where(and(eq(securities.userId, userId), isNull(securities.deletedAt)))
    .orderBy(securities.symbol);
}

async function latestMarketPrices(db: Db, securityIds: string[]): Promise<Map<string, { price: string; asOf: Date }>> {
  const result = new Map<string, { price: string; asOf: Date }>();
  await Promise.all(
    securityIds.map(async (id) => {
      const [row] = await db
        .select({ price: marketPrices.price, asOf: marketPrices.asOf })
        .from(marketPrices)
        .where(eq(marketPrices.securityId, id))
        .orderBy(desc(marketPrices.asOf))
        .limit(1);
      if (row) result.set(id, row);
    }),
  );
  return result;
}

async function latestExchangeRate(db: Db, base: string, quote: string): Promise<{ rate: string; asOf: Date } | null> {
  const [row] = await db
    .select({ rate: exchangeRates.rate, asOf: exchangeRates.asOf })
    .from(exchangeRates)
    .where(and(eq(exchangeRates.base, base), eq(exchangeRates.quote, quote)))
    .orderBy(desc(exchangeRates.asOf))
    .limit(1);
  return row ?? null;
}

interface HoldingValuation {
  id: string;
  assetAccountId: string;
  securityId: string;
  symbol: string;
  name: string;
  market: string;
  currency: string;
  quantityMicro: bigint;
  costBasisMinor: bigint;
  version: number;
  latestPrice: { price: string; asOf: Date } | null;
  /** 有報價用市值；無報價 fallback 成本（顯示會標記 incomplete） */
  marketValueMinor: bigint;
}

/** 持倉市值：quantity × 最新報價（同標的計價幣別，INVESTMENT_MODEL §4）；未換算基準幣別。 */
async function loadHoldingsWithValuation(db: Db, userId: string): Promise<HoldingValuation[]> {
  const rows = await db
    .select({ holding: holdings, security: securities })
    .from(holdings)
    .innerJoin(securities, eq(holdings.securityId, securities.id))
    .where(eq(holdings.userId, userId))
    .orderBy(securities.symbol);
  const prices = await latestMarketPrices(db, [...new Set(rows.map((r) => r.security.id))]);
  return rows.map((r) => {
    const latest = prices.get(r.security.id) ?? null;
    const marketValueMinor = latest
      ? computeMarketValueMinor(r.holding.quantityMicro, latest.price, r.security.currency)
      : r.holding.costBasisMinor;
    return {
      id: r.holding.id,
      assetAccountId: r.holding.assetAccountId,
      securityId: r.security.id,
      symbol: r.security.symbol,
      name: r.security.name,
      market: r.security.market,
      currency: r.security.currency,
      quantityMicro: r.holding.quantityMicro,
      costBasisMinor: r.holding.costBasisMinor,
      version: r.holding.version,
      latestPrice: latest,
      marketValueMinor,
    };
  });
}

/** 持倉一覽（F7 UI 用）：quantity 已轉為十進位字串顯示，marketValueMinor 缺報價時為 null。 */
export async function listHoldings(db: Db, userId: string) {
  const rows = await loadHoldingsWithValuation(db, userId);
  return rows.map((r) => ({
    id: r.id,
    assetAccountId: r.assetAccountId,
    securityId: r.securityId,
    symbol: r.symbol,
    name: r.name,
    market: r.market,
    currency: r.currency,
    quantity: formatQuantity(r.quantityMicro),
    costBasisMinor: r.costBasisMinor,
    version: r.version,
    latestPrice: r.latestPrice,
    marketValueMinor: r.latestPrice ? r.marketValueMinor : null,
  }));
}

/** 未來 30 天預計流出：expected_transactions（尚未確認）＋信用卡待繳（繳款截止在 30 天內）。 */
async function upcomingOutflow30d(
  db: Db,
  userId: string,
  today: CivilDate,
  accountRows: Array<{ id: string; subtype: string }>,
  toBase: (amountMinor: bigint, currency: string) => Promise<bigint>,
): Promise<bigint> {
  const todayStr = formatCivilDate(today);
  const horizon = formatCivilDate(addDays(today, 30));
  let total = 0n;

  const expectedRows = await db
    .select()
    .from(expectedTransactions)
    .where(
      and(
        eq(expectedTransactions.userId, userId),
        isNull(expectedTransactions.deletedAt),
        inArray(expectedTransactions.status, ['scheduled', 'matched']),
        gte(expectedTransactions.expectedDate, todayStr),
        lte(expectedTransactions.expectedDate, horizon),
      ),
    );
  for (const row of expectedRows) {
    if (!row.amountMinor) continue;
    total += await toBase(row.amountMinor, row.currency);
  }

  const cards = accountRows.filter((a) => a.subtype === 'credit_card');
  for (const card of cards) {
    const view = await cardCycleView(db, userId, card.id, today);
    if (!view) continue;
    if (view.previous.unpaidMinor > 0n && view.previous.dueDate <= horizon) {
      total += await toBase(view.previous.unpaidMinor, view.currency);
    }
  }
  return total;
}

/** 淨資產的單一來源（首頁逐帳戶呈現用）：金額已換算基準幣別；負債為正數（欠多少） */
export interface NetWorthSource {
  accountId: string;
  name: string;
  /** 所屬機構：一般帳戶取 institution，信用卡取發卡行 */
  institution: string | null;
  kind: 'cash' | 'investment' | 'liability';
  amountMinor: bigint;
}

export interface NetWorthResult {
  baseCurrency: string;
  cashMinor: bigint;
  investmentsMinor: bigint;
  liabilitiesMinor: bigint;
  netWorthMinor: bigint;
  sources: NetWorthSource[];
  /** 有金額因缺匯率或缺報價而略過換算／用成本墊底 */
  incomplete: boolean;
  /** 用到的匯率/報價中最舊的 as_of；無需任何換算時為 null */
  oldestDataAsOf: Date | null;
  upcomingOutflow30dMinor: bigint;
}

/** 首頁淨資產一覽（INV-5）：資產＋持倉市值－負債，換算到使用者基準幣別。 */
export async function netWorthSummary(db: Db, userId: string, baseCurrency: string, today: CivilDate): Promise<NetWorthResult> {
  const accountRows = await listAccounts(db, userId);
  const rateCache = new Map<string, { rate: string; asOf: Date } | null>();
  let incomplete = false;
  let oldestDataAsOf: Date | null = null;
  const noteAsOf = (asOf: Date) => {
    if (!oldestDataAsOf || asOf < oldestDataAsOf) oldestDataAsOf = asOf;
  };
  const toBase = async (amountMinor: bigint, currency: string): Promise<bigint> => {
    if (currency === baseCurrency || amountMinor === 0n) return amountMinor;
    let cached = rateCache.get(currency);
    if (cached === undefined) {
      cached = await latestExchangeRate(db, currency, baseCurrency);
      rateCache.set(currency, cached);
    }
    if (!cached) {
      incomplete = true;
      return 0n;
    }
    noteAsOf(cached.asOf);
    return convert({ amountMinor, currency }, baseCurrency, cached.rate).amountMinor;
  };

  const sources: NetWorthSource[] = [];
  const orgOf = (account: (typeof accountRows)[number]): string | null =>
    account.institution ?? (account.creditCard && account.creditCard.issuer !== '—' ? account.creditCard.issuer : null);
  let cashMinor = 0n;
  let liabilitiesMinor = 0n;
  for (const account of accountRows) {
    if (account.kind === 'asset' && account.subtype !== 'investment_asset') {
      const converted = await toBase(account.balanceMinor, account.currency);
      cashMinor += converted;
      if (converted !== 0n) sources.push({ accountId: account.id, name: account.name, institution: orgOf(account), kind: 'cash', amountMinor: converted });
    } else if (account.kind === 'liability') {
      const owed = await toBase(-account.balanceMinor, account.currency);
      liabilitiesMinor += owed;
      if (owed !== 0n) sources.push({ accountId: account.id, name: account.name, institution: orgOf(account), kind: 'liability', amountMinor: owed });
    }
  }

  const holdingRows = await loadHoldingsWithValuation(db, userId);
  const investmentByAccount = new Map<string, bigint>();
  let investmentsMinor = 0n;
  for (const holding of holdingRows) {
    if (!holding.latestPrice) incomplete = true;
    else noteAsOf(holding.latestPrice.asOf);
    const converted = await toBase(holding.marketValueMinor, holding.currency);
    investmentsMinor += converted;
    investmentByAccount.set(holding.assetAccountId, (investmentByAccount.get(holding.assetAccountId) ?? 0n) + converted);
  }
  for (const [assetAccountId, amountMinor] of investmentByAccount) {
    if (amountMinor === 0n) continue;
    const account = accountRows.find((a) => a.id === assetAccountId);
    sources.push({
      accountId: assetAccountId,
      name: account?.name ?? '投資',
      institution: account?.institution ?? null,
      kind: 'investment',
      amountMinor,
    });
  }

  const upcomingOutflow30dMinor = await upcomingOutflow30d(db, userId, today, accountRows, toBase);

  return {
    baseCurrency,
    cashMinor,
    investmentsMinor,
    liabilitiesMinor,
    netWorthMinor: cashMinor + investmentsMinor - liabilitiesMinor,
    sources,
    incomplete,
    oldestDataAsOf,
    upcomingOutflow30dMinor,
  };
}

/**
 * 完整匯出（SYNC-8、F10）：所有使用者資料表，含 audit 歷史與 journal。
 * 軟刪除資料一併匯出（資料所有權原則：可完整帶走）。
 */
export async function exportAllData(db: Db, userId: string) {
  const [
    accountRows,
    groupRows,
    cardRows,
    limitGroupRows,
    txnRows,
    linkRows,
    entryRows,
    ruleRows,
    expectedRows,
    auditRows,
    rateRows,
    deviceRows,
    mutationRows,
    changeRows,
    statementRows,
    statementGroupRows,
    sessionRows,
    patchRows,
    aliasRows,
    importFileRows,
    jobRows,
    investmentAccountRows,
    securityRows,
    holdingRows,
    discordLinkRows,
    notificationPreferencesRows,
    notificationLogRows,
    webPushSubscriptionRows,
  ] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.userId, userId)),
    db.select().from(accountGroups).where(eq(accountGroups.userId, userId)),
    db
      .select({ card: creditCards })
      .from(creditCards)
      .innerJoin(accounts, eq(creditCards.accountId, accounts.id))
      .where(eq(accounts.userId, userId)),
    db.select().from(creditLimitGroups).where(eq(creditLimitGroups.userId, userId)),
    db.select().from(transactions).where(eq(transactions.userId, userId)),
    db.select().from(transactionLinks).where(eq(transactionLinks.userId, userId)),
    db.select().from(journalEntries).where(eq(journalEntries.userId, userId)),
    db.select().from(recurringRules).where(eq(recurringRules.userId, userId)),
    db.select().from(expectedTransactions).where(eq(expectedTransactions.userId, userId)),
    db.select().from(auditLogs).where(eq(auditLogs.userId, userId)),
    db.select().from(exchangeRates),
    db.select().from(syncDevices).where(eq(syncDevices.userId, userId)),
    db.select().from(syncMutations).where(eq(syncMutations.userId, userId)),
    db.select().from(changeLog).where(eq(changeLog.userId, userId)),
    db.select().from(statements).where(eq(statements.userId, userId)),
    db.select().from(statementGroups).where(eq(statementGroups.userId, userId)),
    db.select().from(auditSessions).where(eq(auditSessions.userId, userId)),
    db.select().from(proposedPatches).where(eq(proposedPatches.userId, userId)),
    db.select().from(merchantAliases).where(eq(merchantAliases.userId, userId)),
    db.select().from(importFiles).where(eq(importFiles.userId, userId)),
    db.select().from(jobs).where(eq(jobs.userId, userId)),
    db.select().from(investmentAccounts).where(eq(investmentAccounts.userId, userId)),
    db.select().from(securities).where(eq(securities.userId, userId)),
    db.select().from(holdings).where(eq(holdings.userId, userId)),
    db.select().from(discordLinks).where(eq(discordLinks.userId, userId)),
    db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId)),
    db.select().from(notificationLog).where(eq(notificationLog.userId, userId)),
    db.select().from(webPushSubscriptions).where(eq(webPushSubscriptions.userId, userId)),
  ]);
  const securityIds = securityRows.map((s) => s.id);
  const marketPriceRows =
    securityIds.length === 0 ? [] : await db.select().from(marketPrices).where(inArray(marketPrices.securityId, securityIds));
  const entryIds = entryRows.map((e) => e.id);
  const lineRows =
    entryIds.length === 0 ? [] : await db.select().from(journalLines).where(inArray(journalLines.entryId, entryIds));
  const statementIds = statementRows.map((statement) => statement.id);
  const statementItemRows = statementIds.length === 0
    ? []
    : await db.select().from(statementItems).where(inArray(statementItems.statementId, statementIds));
  const sessionIds = sessionRows.map((session) => session.id);
  const candidateRows = sessionIds.length === 0
    ? []
    : await db.select().from(auditCandidates).where(inArray(auditCandidates.sessionId, sessionIds));
  return {
    accounts: accountRows,
    account_groups: groupRows,
    credit_cards: cardRows.map((r) => r.card),
    credit_limit_groups: limitGroupRows,
    transactions: txnRows,
    transaction_links: linkRows,
    journal_entries: entryRows,
    journal_lines: lineRows,
    recurring_rules: ruleRows,
    expected_transactions: expectedRows,
    audit_logs: auditRows,
    exchange_rates: rateRows,
    sync_devices: deviceRows,
    sync_mutations: mutationRows,
    change_log: changeRows,
    statements: statementRows,
    statement_groups: statementGroupRows,
    statement_items: statementItemRows,
    audit_sessions: sessionRows,
    audit_candidates: candidateRows,
    proposed_patches: patchRows,
    merchant_aliases: aliasRows,
    import_files: importFileRows,
    jobs: jobRows,
    investment_accounts: investmentAccountRows,
    securities: securityRows,
    holdings: holdingRows,
    market_prices: marketPriceRows,
    discord_links: discordLinkRows,
    notification_preferences: notificationPreferencesRows,
    notification_log: notificationLogRows,
    web_push_subscriptions: webPushSubscriptionRows,
  };
}
