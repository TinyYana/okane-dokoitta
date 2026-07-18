import {
  applyBuy,
  applySell,
  assertExpectedTransition,
  assertStatusTransition,
  buildPosting,
  currencyExponent,
  DomainError,
  formatCivilDate,
  nextExpectedDate,
  parseCivilDate,
  parseQuantity,
  SUBTYPE_KIND,
  validateSchedule,
  type AccountInfo,
  type AccountSubtype,
  type CardStatus,
  type HoldingState,
  type RateSource,
  type RecurringSchedule,
  type SecurityKind,
  type TransactionInput,
  type TransactionSource,
  type TransactionStatus,
  type TransactionType,
} from '@okane-dokoitta/domain';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { toJsonSafe, type Db } from './client.js';
import { newId } from './ids.js';
import { recordChange } from './sync.js';
import {
  accountGroups,
  accounts,
  auditLogs,
  creditCards,
  creditLimitGroups,
  exchangeRates,
  expectedTransactions,
  holdings,
  investmentAccounts,
  journalEntries,
  journalLines,
  marketPrices,
  recurringRules,
  securities,
  syncMutations,
  transactionLinks,
  transactions,
} from './schema.js';

/**
 * 帳本寫入服務（唯一寫入路徑）：
 * 冪等（mutationId）→ 樂觀版本檢查 → Zod（API 層）+ domain 驗證 → 套用 → audit log，
 * 全部在同一個 DB transaction 內（SYNC_DESIGN §3.2）。
 * repository 不得繞過 domain 直接寫 journal_lines（I-4）。
 */

export interface MutationUser {
  id: string;
  ledgerTimeZone: string;
}

export interface MutationInput {
  mutationId: string;
  deviceId: string;
  entity: string;
  entityId: string;
  op: 'create' | 'update' | 'delete';
  baseVersion: number | null;
  payload: Record<string, unknown>;
  clientAt: string;
}

export interface MutationOutcome {
  mutationId: string;
  result: 'applied' | 'duplicate' | 'rejected_conflict' | 'rejected_invalid';
  version?: number | null;
  error?: { code: string; message: string };
  serverSnapshot?: unknown;
}

class ConflictError extends Error {
  constructor(readonly snapshot: unknown) {
    super('version conflict');
  }
}

// ---------- payload 型別（API 層以 schemas 驗證後傳入；金額已是 bigint）----------

export interface CreditCardPayload {
  issuer: string;
  cardName: string;
  last4?: string | null;
  creditLimitMinor?: bigint | null;
  limitGroupId?: string | null;
  statementDay: number;
  dueDay: number;
  autopayDay?: number | null;
  autopayAccountId?: string | null;
  status: CardStatus;
}

export interface AccountCreatePayload {
  subtype: AccountSubtype;
  name: string;
  institution?: string | null;
  currency: string;
  groupId?: string | null;
  opening?: { transactionId: string; amountMinor: bigint; isLiability: boolean } | null;
  creditCard?: CreditCardPayload | null;
}

export interface AccountUpdatePayload {
  name?: string;
  institution?: string | null;
  groupId?: string | null;
  archived?: boolean;
  creditCard?: Partial<CreditCardPayload>;
}

export interface TransactionCreatePayload {
  type: TransactionType;
  status?: TransactionStatus;
  amountMinor: bigint;
  currency: string;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  categoryAccountId?: string | null;
  originalTransactionId?: string | null;
  costBasisMinor?: bigint | null;
  merchantRaw?: string | null;
  note?: string | null;
  occurredAt: string;
  authorizedAt?: string | null;
  postedAt?: string | null;
  dueDate?: string | null;
  installmentCurrent?: number | null;
  installmentTotal?: number | null;
  expectedTransactionId?: string | null;
  recurringRuleId?: string | null;
  /** invest_buy/invest_sell/dividend 或 adjustment 期初持倉（M4）：券商 → server 解析對應帳戶 */
  investmentAccountId?: string | null;
  securityId?: string | null;
  /** 十進位股數字串；與 investmentAccountId 搭配才會維護 holdings */
  quantity?: string | null;
  source: TransactionSource;
  needsReview?: boolean;
}

export type TransactionUpdatePayload = Partial<
  Pick<
    TransactionCreatePayload,
    | 'status'
    | 'amountMinor'
    | 'fromAccountId'
    | 'toAccountId'
    | 'categoryAccountId'
    | 'merchantRaw'
    | 'note'
    | 'occurredAt'
    | 'authorizedAt'
    | 'postedAt'
    | 'dueDate'
  >
> & { needsReview?: boolean };

export interface RecurringRuleCreatePayload {
  name: string;
  schedule: RecurringSchedule;
  amountMinor?: bigint | null;
  currency: string;
  amountToleranceMinor: bigint;
  dateToleranceDays: number;
  /** kind=invest_buy 時可省略，server 以 investmentAccountId 解析交割戶 */
  accountId?: string;
  categoryAccountId?: string | null;
  merchantHint?: string | null;
  /** 定期定額（Q18 圈存式）：invest_buy 需要 investmentAccountId＋securityId＋amountMinor（預估額） */
  kind?: 'expense' | 'invest_buy';
  investmentAccountId?: string | null;
  securityId?: string | null;
  active: boolean;
  nextExpectedDate: string;
}

export interface ExpectedUpdatePayload {
  status: 'scheduled' | 'matched' | 'confirmed' | 'missed' | 'skipped';
  matchedTransactionId?: string | null;
}

// ---------- 投資（M4）----------

export interface InvestmentAccountCreatePayload {
  name: string;
  institution?: string | null;
  currency: string;
}
export interface InvestmentAccountUpdatePayload {
  name?: string;
}

export interface SecurityCreatePayload {
  symbol: string;
  name: string;
  market: string;
  currency: string;
  kind: SecurityKind;
}
export type SecurityUpdatePayload = Partial<SecurityCreatePayload>;

export interface MarketPriceCreatePayload {
  securityId: string;
  price: string;
  asOf: string;
  source: RateSource;
}

export interface ExchangeRateCreatePayload {
  base: string;
  quote: string;
  rate: string;
  asOf: string;
  source: RateSource;
}

// ---------- 入口 ----------

export async function applyMutation(db: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  try {
    return await db.transaction(async (tx) => {
      // 冪等：mutation_id 已存在 → 回傳首次結果，不重複套用
      const [existing] = await tx.select().from(syncMutations).where(eq(syncMutations.mutationId, m.mutationId)).limit(1);
      if (existing) {
        if (existing.userId !== user.id) {
          return rejectedInvalid(m, 'MUTATION_ID_FOREIGN', 'mutationId 已被使用');
        }
        return {
          mutationId: m.mutationId,
          result: existing.result === 'applied' ? 'duplicate' : existing.result,
          version: existing.appliedVersion,
          ...(existing.errorCode ? { error: { code: existing.errorCode, message: '首次結果' } } : {}),
        };
      }

      let outcome: MutationOutcome;
      try {
        // savepoint：驗證失敗時 rollback 業務寫入，但保留 sync_mutations 紀錄
        outcome = await tx.transaction(async (inner) => dispatch(inner as unknown as Db, user, m));
      } catch (err) {
        if (err instanceof DomainError) {
          outcome = rejectedInvalid(m, err.code, err.message);
        } else if (err instanceof ConflictError) {
          outcome = {
            mutationId: m.mutationId,
            result: 'rejected_conflict',
            error: { code: 'VERSION_CONFLICT', message: '資料已被其他寫入更新，請重新載入' },
            serverSnapshot: err.snapshot,
          };
        } else {
          throw err;
        }
      }

      await tx.insert(syncMutations).values({
        mutationId: m.mutationId,
        userId: user.id,
        deviceId: m.deviceId,
        entity: m.entity,
        entityId: m.entityId,
        op: m.op,
        baseVersion: m.baseVersion,
        payload: toJsonSafe(m.payload) as Record<string, unknown>,
        result: outcome.result === 'applied' ? 'applied' : outcome.result,
        appliedVersion: outcome.version ?? null,
        errorCode: outcome.error?.code ?? null,
      });
      if (outcome.result === 'applied' && outcome.version) {
        await recordChange(tx as unknown as Db, user.id, m.entity, m.entityId, outcome.version);
      }
      return outcome;
    });
  } catch (err) {
    // 併發送同一 mutationId：第二個 insert 撞 PK → 讀回首次結果
    if (isUniqueViolation(err)) {
      const [row] = await db.select().from(syncMutations).where(eq(syncMutations.mutationId, m.mutationId)).limit(1);
      if (row) {
        return {
          mutationId: m.mutationId,
          result: row.result === 'applied' ? 'duplicate' : row.result,
          version: row.appliedVersion,
        };
      }
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

function rejectedInvalid(m: MutationInput, code: string, message: string): MutationOutcome {
  return { mutationId: m.mutationId, result: 'rejected_invalid', error: { code, message } };
}

function invalid(code: string, message: string): DomainError {
  return new DomainError(code as never, message);
}

async function dispatch(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  switch (`${m.entity}:${m.op}`) {
    case 'accounts:create':
      return createAccount(tx, user, m);
    case 'accounts:update':
      return updateAccount(tx, user, m);
    case 'accounts:delete':
      return deleteAccount(tx, user, m);
    case 'account_groups:create':
      return createAccountGroup(tx, user, m);
    case 'account_groups:update':
      return updateAccountGroup(tx, user, m);
    case 'account_groups:delete':
      return deleteAccountGroup(tx, user, m);
    case 'credit_limit_groups:create':
      return createLimitGroup(tx, user, m);
    case 'credit_limit_groups:update':
      return updateLimitGroup(tx, user, m);
    case 'credit_limit_groups:delete':
      return deleteLimitGroup(tx, user, m);
    case 'transactions:create':
      return createTransaction(tx, user, m);
    case 'transactions:update':
      return updateTransaction(tx, user, m);
    case 'transactions:delete':
      return deleteTransaction(tx, user, m);
    case 'recurring_rules:create':
      return createRecurringRule(tx, user, m);
    case 'recurring_rules:update':
      return updateRecurringRule(tx, user, m);
    case 'recurring_rules:delete':
      return deleteRecurringRule(tx, user, m);
    case 'expected_transactions:update':
      return updateExpectedTransaction(tx, user, m);
    case 'investment_accounts:create':
      return createInvestmentAccount(tx, user, m);
    case 'investment_accounts:update':
      return updateInvestmentAccount(tx, user, m);
    case 'investment_accounts:delete':
      return deleteInvestmentAccount(tx, user, m);
    case 'securities:create':
      return createSecurity(tx, user, m);
    case 'securities:update':
      return updateSecurity(tx, user, m);
    case 'securities:delete':
      return deleteSecurity(tx, user, m);
    case 'market_prices:create':
      return createMarketPrice(tx, user, m);
    case 'exchange_rates:create':
      return createExchangeRate(tx, user, m);
    default:
      throw invalid('TRANSACTION_TYPE_INVALID', `不支援的 mutation: ${m.entity}:${m.op}`);
  }
}

// ---------- 共用 ----------

async function audit(
  tx: Db,
  userId: string,
  entity: string,
  entityId: string,
  action: string,
  before: unknown,
  after: unknown,
  mutationId: string | null,
  actor: 'user' | 'patch' = 'user',
): Promise<void> {
  await tx.insert(auditLogs).values({
    id: newId(),
    userId,
    actor,
    entity,
    entityId,
    action,
    before: before === null ? null : (toJsonSafe(before) as Record<string, unknown>),
    after: after === null ? null : (toJsonSafe(after) as Record<string, unknown>),
    mutationId,
  });
}

function requireBaseVersion(m: MutationInput): number {
  if (m.baseVersion === null) throw invalid('AMOUNT_INVALID', 'update/delete 必須帶 baseVersion');
  return m.baseVersion;
}

function checkVersion(current: { version: number }, base: number, snapshot: unknown): void {
  if (current.version !== base) throw new ConflictError(toJsonSafe(snapshot));
}

async function loadAccountInfos(tx: Db, userId: string, ids: string[]): Promise<Map<string, AccountInfo>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), inArray(accounts.id, unique)));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        kind: r.kind,
        subtype: r.subtype,
        currency: r.currency,
        deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
        archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
      } satisfies AccountInfo,
    ]),
  );
}

async function getOpeningEquityAccountId(tx: Db, userId: string, mutationId: string): Promise<string> {
  const [row] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.subtype, 'opening_balance'), isNull(accounts.deletedAt)))
    .limit(1);
  if (row) return row.id;

  // 期初餘額是帳本不變量；舊備份或早期 UI 若把它刪掉，不能讓期初持倉永久卡死。
  const [deleted] = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.subtype, 'opening_balance')))
    .limit(1);
  if (deleted) {
    const next = { deletedAt: null, archivedAt: null, version: deleted.version + 1, updatedAt: new Date() };
    await tx.update(accounts).set(next).where(and(eq(accounts.id, deleted.id), eq(accounts.userId, userId)));
    await audit(tx, userId, 'accounts', deleted.id, 'update', deleted, { ...deleted, ...next }, mutationId);
    await recordChange(tx, userId, 'accounts', deleted.id, next.version);
    return deleted.id;
  }

  const id = newId();
  const created = { id, userId, kind: 'equity' as const, subtype: 'opening_balance' as const, name: '期初餘額', currency: 'TWD' };
  const [inserted] = await tx.insert(accounts).values(created).onConflictDoNothing().returning({ id: accounts.id });
  if (inserted) {
    await audit(tx, userId, 'accounts', id, 'create', null, created, mutationId);
    await recordChange(tx, userId, 'accounts', id, 1);
    return id;
  }

  // 同一使用者的另一筆 mutation 剛建立完成；唯一索引保證此查詢最多只會有一筆。
  const [concurrent] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.subtype, 'opening_balance')))
    .limit(1);
  if (!concurrent) throw new Error('期初餘額帳戶建立後無法讀回');
  return concurrent.id;
}

// ---------- holdings（M4：平均成本法，由 invest_buy/invest_sell 維護，非直接寫入）----------

type HoldingRow = typeof holdings.$inferSelect;

function holdingState(row: HoldingRow): HoldingState {
  return { quantityMicro: row.quantityMicro, costBasisMinor: row.costBasisMinor };
}

async function loadHolding(tx: Db, assetAccountId: string, securityId: string): Promise<HoldingRow | null> {
  const [row] = await tx
    .select()
    .from(holdings)
    .where(and(eq(holdings.assetAccountId, assetAccountId), eq(holdings.securityId, securityId)))
    .limit(1);
  return row ?? null;
}

async function writeHolding(
  tx: Db,
  userId: string,
  assetAccountId: string,
  securityId: string,
  current: HoldingRow | null,
  next: HoldingState,
  mutationId: string | null,
): Promise<void> {
  if (current) {
    const row = {
      quantityMicro: next.quantityMicro,
      costBasisMinor: next.costBasisMinor,
      version: current.version + 1,
      updatedAt: new Date(),
    };
    await tx.update(holdings).set(row).where(eq(holdings.id, current.id));
    await audit(tx, userId, 'holdings', current.id, 'update', current, { ...current, ...row }, mutationId);
  } else {
    const id = newId();
    const row = { id, userId, assetAccountId, securityId, quantityMicro: next.quantityMicro, costBasisMinor: next.costBasisMinor };
    await tx.insert(holdings).values(row);
    await audit(tx, userId, 'holdings', id, 'create', null, row, mutationId);
  }
}

/** 交易寫入核心：domain 驗證 → transactions + journal entry/lines + links + audit。 */
async function insertTransactionWithEntry(
  tx: Db,
  user: MutationUser,
  input: TransactionInput,
  extra: {
    mutationId: string | null;
    dueDate?: string | null;
    expectedTransactionId?: string | null;
    recurringRuleId?: string | null;
    securityId?: string | null;
    quantityMicro?: bigint | null;
  },
): Promise<{ version: number }> {
  const accountIds = [input.fromAccountId, input.toAccountId, input.categoryAccountId].filter(
    (v): v is string => typeofv(v),
  );
  const infos = await loadAccountInfos(tx, user.id, accountIds);
  // 越權防護：payload 引用不屬於本使用者的帳戶 → 查不到 → ACCOUNT_NOT_FOUND
  const posting = buildPosting(input, infos, user.ledgerTimeZone);

  if (input.originalTransactionId) {
    const [orig] = await tx
      .select({ id: transactions.id, deletedAt: transactions.deletedAt })
      .from(transactions)
      .where(and(eq(transactions.id, input.originalTransactionId), eq(transactions.userId, user.id)))
      .limit(1);
    if (!orig || orig.deletedAt) throw invalid('REFUND_ORIGINAL_INVALID', '退款的原始交易不存在');
  }

  const txnRow = {
    id: input.id,
    userId: user.id,
    type: input.type,
    status: input.status,
    amountMinor: input.amountMinor,
    currency: input.currency,
    fromAccountId: input.fromAccountId ?? null,
    toAccountId: input.toAccountId ?? null,
    categoryAccountId: input.categoryAccountId ?? null,
    merchantRaw: input.merchantRaw ?? null,
    note: input.note ?? null,
    occurredAt: new Date(input.occurredAt),
    authorizedAt: input.authorizedAt ? new Date(input.authorizedAt) : null,
    postedAt: input.postedAt ? new Date(input.postedAt) : null,
    dueDate: extra.dueDate ?? null,
    installmentCurrent: input.installmentCurrent ?? null,
    installmentTotal: input.installmentTotal ?? null,
    expectedTransactionId: extra.expectedTransactionId ?? null,
    recurringRuleId: extra.recurringRuleId ?? null,
    securityId: extra.securityId ?? null,
    quantityMicro: extra.quantityMicro ?? null,
    source: input.source,
    needsReview: input.needsReview ?? false,
  };
  await tx.insert(transactions).values(txnRow);

  const entryId = newId();
  await tx.insert(journalEntries).values({
    id: entryId,
    userId: user.id,
    entryDate: posting.entry.entryDate,
    description: posting.entry.description,
    transactionId: input.id,
  });
  await tx.insert(journalLines).values(
    posting.entry.lines.map((line, i) => ({
      id: newId(),
      entryId,
      lineNo: i + 1,
      accountId: line.accountId,
      amountMinor: line.amountMinor,
      currency: line.currency,
    })),
  );
  for (const link of posting.links) {
    await tx.insert(transactionLinks).values({
      id: newId(),
      userId: user.id,
      kind: link.kind,
      fromTransactionId: link.fromTransactionId,
      toTransactionId: link.toTransactionId,
      metadata: link.metadata ?? null,
    });
  }
  await audit(
    tx,
    user.id,
    'transactions',
    input.id,
    'create',
    null,
    { ...txnRow, entry: posting.entry },
    extra.mutationId,
    input.source === 'patch' ? 'patch' : 'user',
  );
  return { version: 1 };
}

function typeofv(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.length > 0;
}

// ---------- accounts ----------

async function createAccount(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const p = m.payload as unknown as AccountCreatePayload;
  currencyExponent(p.currency);
  const kind = SUBTYPE_KIND[p.subtype];
  if (p.subtype === 'credit_card' && !p.creditCard) {
    throw invalid('ACCOUNT_KIND_INVALID', '信用卡帳戶必須附 creditCard 欄位');
  }
  if (p.subtype !== 'credit_card' && p.creditCard) {
    throw invalid('ACCOUNT_KIND_INVALID', '非信用卡帳戶不可附 creditCard 欄位');
  }
  if (p.groupId) {
    const [g] = await tx
      .select({ id: accountGroups.id })
      .from(accountGroups)
      .where(and(eq(accountGroups.id, p.groupId), eq(accountGroups.userId, user.id), isNull(accountGroups.deletedAt)))
      .limit(1);
    if (!g) throw invalid('ACCOUNT_NOT_FOUND', '帳戶群組不存在');
  }

  const row = {
    id: m.entityId,
    userId: user.id,
    kind,
    subtype: p.subtype,
    name: p.name,
    institution: p.institution ?? null,
    currency: p.currency,
    groupId: p.groupId ?? null,
  };
  await tx.insert(accounts).values(row);

  if (p.creditCard) {
    const cc = p.creditCard;
    if (cc.limitGroupId) {
      const [g] = await tx
        .select({ id: creditLimitGroups.id })
        .from(creditLimitGroups)
        .where(and(eq(creditLimitGroups.id, cc.limitGroupId), eq(creditLimitGroups.userId, user.id), isNull(creditLimitGroups.deletedAt)))
        .limit(1);
      if (!g) throw invalid('ACCOUNT_NOT_FOUND', '共用額度群組不存在');
    }
    if (cc.autopayAccountId) {
      const infos = await loadAccountInfos(tx, user.id, [cc.autopayAccountId]);
      const autopay = infos.get(cc.autopayAccountId);
      if (!autopay || autopay.kind !== 'asset') throw invalid('ACCOUNT_KIND_INVALID', '自動扣款帳戶必須是資產帳戶');
    }
    await tx.insert(creditCards).values({
      accountId: m.entityId,
      issuer: cc.issuer,
      cardName: cc.cardName,
      last4: cc.last4 ?? null,
      creditLimitMinor: cc.creditLimitMinor ?? null,
      limitGroupId: cc.limitGroupId ?? null,
      statementDay: cc.statementDay,
      dueDay: cc.dueDay,
      autopayDay: cc.autopayDay ?? null,
      autopayAccountId: cc.autopayAccountId ?? null,
      status: cc.status,
    });
  }
  await audit(tx, user.id, 'accounts', m.entityId, 'create', null, { ...row, creditCard: p.creditCard ?? null }, m.mutationId);

  // 期初餘額：對 opening_balance equity 做平衡分錄（餘額永遠是 lines 加總）
  if (p.opening) {
    const equityId = await getOpeningEquityAccountId(tx, user.id, m.mutationId);
    await insertTransactionWithEntry(
      tx,
      user,
      {
        id: p.opening.transactionId,
        type: 'adjustment',
        status: 'posted',
        amountMinor: p.opening.amountMinor,
        currency: p.currency,
        fromAccountId: p.opening.isLiability ? m.entityId : equityId,
        toAccountId: p.opening.isLiability ? equityId : m.entityId,
        note: `期初餘額：${p.name}`,
        occurredAt: m.clientAt,
        source: 'manual',
      },
      { mutationId: m.mutationId },
    );
    await recordChange(tx, user.id, 'transactions', p.opening.transactionId, 1);
  }
  return { mutationId: m.mutationId, result: 'applied', version: 1 };
}

async function updateAccount(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const p = m.payload as unknown as AccountUpdatePayload;
  const base = requireBaseVersion(m);
  const [current] = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, m.entityId), eq(accounts.userId, user.id), isNull(accounts.deletedAt)))
    .limit(1);
  if (!current) throw invalid('ACCOUNT_NOT_FOUND', '帳戶不存在');
  checkVersion(current, base, current);

  const next = {
    name: p.name ?? current.name,
    institution: p.institution === undefined ? current.institution : p.institution,
    groupId: p.groupId === undefined ? current.groupId : p.groupId,
    archivedAt: p.archived === undefined ? current.archivedAt : p.archived ? new Date() : null,
    version: current.version + 1,
    updatedAt: new Date(),
  };
  await tx.update(accounts).set(next).where(eq(accounts.id, current.id));

  let ccBefore: unknown = null;
  let ccAfter: unknown = null;
  if (p.creditCard) {
    if (current.subtype !== 'credit_card') throw invalid('ACCOUNT_KIND_INVALID', '非信用卡帳戶不可更新 creditCard');
    const [cc] = await tx.select().from(creditCards).where(eq(creditCards.accountId, current.id)).limit(1);
    if (!cc) throw invalid('ACCOUNT_NOT_FOUND', '信用卡資料不存在');
    ccBefore = cc;
    const merged = {
      issuer: p.creditCard.issuer ?? cc.issuer,
      cardName: p.creditCard.cardName ?? cc.cardName,
      last4: p.creditCard.last4 === undefined ? cc.last4 : p.creditCard.last4,
      creditLimitMinor: p.creditCard.creditLimitMinor === undefined ? cc.creditLimitMinor : p.creditCard.creditLimitMinor,
      limitGroupId: p.creditCard.limitGroupId === undefined ? cc.limitGroupId : p.creditCard.limitGroupId,
      statementDay: p.creditCard.statementDay ?? cc.statementDay,
      dueDay: p.creditCard.dueDay ?? cc.dueDay,
      autopayDay: p.creditCard.autopayDay === undefined ? cc.autopayDay : p.creditCard.autopayDay,
      autopayAccountId: p.creditCard.autopayAccountId === undefined ? cc.autopayAccountId : p.creditCard.autopayAccountId,
      status: p.creditCard.status ?? cc.status,
    };
    await tx.update(creditCards).set(merged).where(eq(creditCards.accountId, current.id));
    ccAfter = merged;
  }
  await audit(
    tx,
    user.id,
    'accounts',
    m.entityId,
    'update',
    { ...current, creditCard: ccBefore },
    { ...current, ...next, creditCard: ccAfter },
    m.mutationId,
  );
  return { mutationId: m.mutationId, result: 'applied', version: next.version };
}

async function deleteAccount(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const base = requireBaseVersion(m);
  const [current] = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, m.entityId), eq(accounts.userId, user.id), isNull(accounts.deletedAt)))
    .limit(1);
  if (!current) throw invalid('ACCOUNT_NOT_FOUND', '帳戶不存在');
  checkVersion(current, base, current);

  const [linkedInvestment] = await tx
    .select({ id: investmentAccounts.id })
    .from(investmentAccounts)
    .where(
      and(
        or(eq(investmentAccounts.settlementAccountId, current.id), eq(investmentAccounts.assetAccountId, current.id)),
        isNull(investmentAccounts.deletedAt),
      ),
    )
    .limit(1);
  if (linkedInvestment) throw invalid('ACCOUNT_IN_USE', '此帳戶屬於投資帳戶配對，請改由「投資帳戶」管理與刪除');

  const [used] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(and(eq(journalLines.accountId, current.id), isNull(journalEntries.deletedAt)));
  if ((used?.n ?? 0) > 0) {
    throw invalid('ACCOUNT_IN_USE', '帳戶已有帳務紀錄，請改用封存（歷史照常保留）');
  }
  const next = { deletedAt: new Date(), version: current.version + 1, updatedAt: new Date() };
  await tx.update(accounts).set(next).where(eq(accounts.id, current.id));
  await audit(tx, user.id, 'accounts', m.entityId, 'delete', current, { ...current, ...next }, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: next.version };
}

// ---------- account_groups / credit_limit_groups ----------

async function createAccountGroup(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const p = m.payload as { name: string; sortOrder: number };
  const row = { id: m.entityId, userId: user.id, name: p.name, sortOrder: p.sortOrder };
  await tx.insert(accountGroups).values(row);
  await audit(tx, user.id, 'account_groups', m.entityId, 'create', null, row, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: 1 };
}

async function updateAccountGroup(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const p = m.payload as Partial<{ name: string; sortOrder: number }>;
  const base = requireBaseVersion(m);
  const [current] = await tx
    .select()
    .from(accountGroups)
    .where(and(eq(accountGroups.id, m.entityId), eq(accountGroups.userId, user.id), isNull(accountGroups.deletedAt)))
    .limit(1);
  if (!current) throw invalid('ACCOUNT_NOT_FOUND', '帳戶群組不存在');
  checkVersion(current, base, current);
  const next = {
    name: p.name ?? current.name,
    sortOrder: p.sortOrder ?? current.sortOrder,
    version: current.version + 1,
    updatedAt: new Date(),
  };
  await tx.update(accountGroups).set(next).where(eq(accountGroups.id, current.id));
  await audit(tx, user.id, 'account_groups', m.entityId, 'update', current, { ...current, ...next }, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: next.version };
}

async function deleteAccountGroup(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const base = requireBaseVersion(m);
  const [current] = await tx
    .select()
    .from(accountGroups)
    .where(and(eq(accountGroups.id, m.entityId), eq(accountGroups.userId, user.id), isNull(accountGroups.deletedAt)))
    .limit(1);
  if (!current) throw invalid('ACCOUNT_NOT_FOUND', '帳戶群組不存在');
  checkVersion(current, base, current);
  const next = { deletedAt: new Date(), version: current.version + 1, updatedAt: new Date() };
  await tx.update(accountGroups).set(next).where(eq(accountGroups.id, current.id));
  // 引用此群組的帳戶回到未分組（version 同步遞增，M2 鏡像才看得到變更）
  const affectedAccounts = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.groupId, current.id), eq(accounts.userId, user.id)));
  const changedAccounts = await tx
    .update(accounts)
    .set({ groupId: null, version: sql`${accounts.version} + 1`, updatedAt: new Date() })
    .where(and(eq(accounts.groupId, current.id), eq(accounts.userId, user.id)))
    .returning({ id: accounts.id, version: accounts.version });
  for (const changed of changedAccounts) {
    const before = affectedAccounts.find((account) => account.id === changed.id);
    await audit(tx, user.id, 'accounts', changed.id, 'remove_group', before ?? null, { ...(before ?? {}), groupId: null, version: changed.version }, m.mutationId);
    await recordChange(tx, user.id, 'accounts', changed.id, changed.version);
  }
  await audit(tx, user.id, 'account_groups', m.entityId, 'delete', current, { ...current, ...next }, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: next.version };
}

async function createLimitGroup(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const p = m.payload as { name: string; issuer: string; limitMinor: bigint };
  if (p.limitMinor <= 0n) throw invalid('AMOUNT_NOT_POSITIVE', '額度必須為正');
  const row = { id: m.entityId, userId: user.id, name: p.name, issuer: p.issuer, limitMinor: p.limitMinor };
  await tx.insert(creditLimitGroups).values(row);
  await audit(tx, user.id, 'credit_limit_groups', m.entityId, 'create', null, row, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: 1 };
}

async function updateLimitGroup(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const p = m.payload as Partial<{ name: string; issuer: string; limitMinor: bigint }>;
  const base = requireBaseVersion(m);
  const [current] = await tx
    .select()
    .from(creditLimitGroups)
    .where(and(eq(creditLimitGroups.id, m.entityId), eq(creditLimitGroups.userId, user.id), isNull(creditLimitGroups.deletedAt)))
    .limit(1);
  if (!current) throw invalid('ACCOUNT_NOT_FOUND', '共用額度群組不存在');
  checkVersion(current, base, current);
  if (p.limitMinor !== undefined && p.limitMinor <= 0n) throw invalid('AMOUNT_NOT_POSITIVE', '額度必須為正');
  const next = {
    name: p.name ?? current.name,
    issuer: p.issuer ?? current.issuer,
    limitMinor: p.limitMinor ?? current.limitMinor,
    version: current.version + 1,
    updatedAt: new Date(),
  };
  await tx.update(creditLimitGroups).set(next).where(eq(creditLimitGroups.id, current.id));
  await audit(tx, user.id, 'credit_limit_groups', m.entityId, 'update', current, { ...current, ...next }, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: next.version };
}

async function deleteLimitGroup(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const base = requireBaseVersion(m);
  const [current] = await tx
    .select()
    .from(creditLimitGroups)
    .where(and(eq(creditLimitGroups.id, m.entityId), eq(creditLimitGroups.userId, user.id), isNull(creditLimitGroups.deletedAt)))
    .limit(1);
  if (!current) throw invalid('ACCOUNT_NOT_FOUND', '共用額度群組不存在');
  checkVersion(current, base, current);
  const [used] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(creditCards)
    .innerJoin(accounts, eq(creditCards.accountId, accounts.id))
    .where(and(eq(creditCards.limitGroupId, current.id), isNull(accounts.deletedAt)));
  if ((used?.n ?? 0) > 0) throw invalid('GROUP_IN_USE', '仍有信用卡掛在此額度群組');
  const next = { deletedAt: new Date(), version: current.version + 1, updatedAt: new Date() };
  await tx.update(creditLimitGroups).set(next).where(eq(creditLimitGroups.id, current.id));
  await audit(tx, user.id, 'credit_limit_groups', m.entityId, 'delete', current, { ...current, ...next }, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: next.version };
}

// ---------- transactions ----------

async function createTransaction(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const p = m.payload as unknown as TransactionCreatePayload;
  // 引用的 expected / rule 必須屬於本使用者（IDOR 防護）
  if (p.expectedTransactionId) {
    const [row] = await tx
      .select({ id: expectedTransactions.id })
      .from(expectedTransactions)
      .where(and(eq(expectedTransactions.id, p.expectedTransactionId), eq(expectedTransactions.userId, user.id)))
      .limit(1);
    if (!row) throw invalid('ACCOUNT_NOT_FOUND', '引用的預計交易不存在');
  }
  if (p.recurringRuleId) {
    const [row] = await tx
      .select({ id: recurringRules.id })
      .from(recurringRules)
      .where(and(eq(recurringRules.id, p.recurringRuleId), eq(recurringRules.userId, user.id)))
      .limit(1);
    if (!row) throw invalid('ACCOUNT_NOT_FOUND', '引用的週期規則不存在');
  }
  // 投資買賣/股息/期初持倉（M4）：指定券商 → 解析對應帳戶；有股數時同步維護 holdings
  let fromAccountId = p.fromAccountId ?? null;
  let toAccountId = p.toAccountId ?? null;
  let costBasisMinor = p.costBasisMinor ?? null;
  let holdingUpdate: { assetAccountId: string; securityId: string; current: HoldingRow | null; next: HoldingState } | null = null;
  let holdingQuantityMicro: bigint | null = null;

  if (p.investmentAccountId) {
    const [inv] = await tx
      .select()
      .from(investmentAccounts)
      .where(and(eq(investmentAccounts.id, p.investmentAccountId), eq(investmentAccounts.userId, user.id), isNull(investmentAccounts.deletedAt)))
      .limit(1);
    if (!inv) throw invalid('ACCOUNT_NOT_FOUND', '找不到投資帳戶');
    if ((p.type === 'invest_buy' || p.type === 'invest_sell' || p.type === 'adjustment') && (!p.securityId || !p.quantity)) {
      throw invalid('TRANSACTION_TYPE_INVALID', '投資買賣或期初持倉必須指定標的與股數');
    }
    if (p.securityId) {
      const [security] = await tx
        .select({ id: securities.id, currency: securities.currency })
        .from(securities)
        .where(and(eq(securities.id, p.securityId), eq(securities.userId, user.id), isNull(securities.deletedAt)))
        .limit(1);
      if (!security) throw invalid('ACCOUNT_NOT_FOUND', '找不到投資標的');
      if (security.currency !== inv.currency || p.currency !== inv.currency) {
        throw invalid('CURRENCY_MISMATCH', '投資帳戶、標的與交易幣別必須一致');
      }
    }
    if (p.type === 'invest_buy') {
      fromAccountId = inv.settlementAccountId;
      toAccountId = inv.assetAccountId;
    } else if (p.type === 'invest_sell') {
      fromAccountId = inv.assetAccountId;
      toAccountId = inv.settlementAccountId;
    } else if (p.type === 'dividend') {
      toAccountId = inv.settlementAccountId;
    } else if (p.type === 'adjustment') {
      fromAccountId = await getOpeningEquityAccountId(tx, user.id, m.mutationId);
      toAccountId = inv.assetAccountId;
    }

    if ((p.type === 'invest_buy' || p.type === 'invest_sell' || p.type === 'adjustment') && p.securityId && p.quantity) {
      const quantityMicro = parseQuantity(p.quantity);
      holdingQuantityMicro = quantityMicro;
      const current = await loadHolding(tx, inv.assetAccountId, p.securityId);
      if (p.type === 'invest_buy' || p.type === 'adjustment') {
        const next = applyBuy(current ? holdingState(current) : undefined, quantityMicro, p.amountMinor);
        holdingUpdate = { assetAccountId: inv.assetAccountId, securityId: p.securityId, current, next };
      } else {
        const { next, costBasisMinor: consumed } = applySell(current ? holdingState(current) : undefined, quantityMicro);
        costBasisMinor = consumed;
        holdingUpdate = { assetAccountId: inv.assetAccountId, securityId: p.securityId, current, next };
      }
    }
  }

  // 預設狀態：信用卡消費 pending（未入帳），其餘 posted
  let status = p.status;
  if (!status) {
    const infos = await loadAccountInfos(tx, user.id, [fromAccountId ?? ''].filter(Boolean));
    const from = fromAccountId ? infos.get(fromAccountId) : undefined;
    status = from?.subtype === 'credit_card' ? 'pending' : 'posted';
  }
  const input: TransactionInput = {
    id: m.entityId,
    type: p.type,
    status,
    amountMinor: p.amountMinor,
    currency: p.currency,
    fromAccountId: fromAccountId ?? undefined,
    toAccountId: toAccountId ?? undefined,
    categoryAccountId: p.categoryAccountId ?? undefined,
    originalTransactionId: p.originalTransactionId ?? undefined,
    costBasisMinor: costBasisMinor ?? undefined,
    merchantRaw: p.merchantRaw ?? undefined,
    note: p.note ?? undefined,
    occurredAt: p.occurredAt,
    authorizedAt: p.authorizedAt ?? undefined,
    postedAt: p.postedAt ?? undefined,
    installmentCurrent: p.installmentCurrent ?? undefined,
    installmentTotal: p.installmentTotal ?? undefined,
    source: p.source,
    needsReview: p.needsReview,
  };
  await insertTransactionWithEntry(tx, user, input, {
    mutationId: m.mutationId,
    dueDate: p.dueDate ?? null,
    expectedTransactionId: p.expectedTransactionId ?? null,
    recurringRuleId: p.recurringRuleId ?? null,
    securityId: p.securityId ?? null,
    quantityMicro: holdingQuantityMicro,
  });
  if (holdingUpdate) {
    await writeHolding(tx, user.id, holdingUpdate.assetAccountId, holdingUpdate.securityId, holdingUpdate.current, holdingUpdate.next, m.mutationId);
  }
  return { mutationId: m.mutationId, result: 'applied', version: 1 };
}

async function updateTransaction(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const p = m.payload as unknown as TransactionUpdatePayload;
  const base = requireBaseVersion(m);
  const [current] = await tx
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, m.entityId), eq(transactions.userId, user.id), isNull(transactions.deletedAt)))
    .limit(1);
  if (!current) throw invalid('ACCOUNT_NOT_FOUND', '交易不存在');
  checkVersion(current, base, current);

  if (p.status && p.status !== current.status) {
    assertStatusTransition(current.status, p.status);
  }

  const next = {
    status: p.status ?? current.status,
    needsReview: p.needsReview ?? current.needsReview,
    amountMinor: p.amountMinor ?? current.amountMinor,
    fromAccountId: p.fromAccountId === undefined ? current.fromAccountId : p.fromAccountId,
    toAccountId: p.toAccountId === undefined ? current.toAccountId : p.toAccountId,
    categoryAccountId: p.categoryAccountId === undefined ? current.categoryAccountId : p.categoryAccountId,
    merchantRaw: p.merchantRaw === undefined ? current.merchantRaw : p.merchantRaw,
    note: p.note === undefined ? current.note : p.note,
    occurredAt: p.occurredAt ? new Date(p.occurredAt) : current.occurredAt,
    authorizedAt: p.authorizedAt === undefined ? current.authorizedAt : p.authorizedAt ? new Date(p.authorizedAt) : null,
    postedAt: p.postedAt === undefined ? current.postedAt : p.postedAt ? new Date(p.postedAt) : null,
    dueDate: p.dueDate === undefined ? current.dueDate : p.dueDate,
    version: current.version + 1,
    updatedAt: new Date(),
  };

  // 帳務欄位變更 → 重新產生分錄；舊 entry 軟刪除（不物理刪除帳務資料）
  const financialChanged =
    next.amountMinor !== current.amountMinor ||
    next.fromAccountId !== current.fromAccountId ||
    next.toAccountId !== current.toAccountId ||
    next.categoryAccountId !== current.categoryAccountId ||
    next.occurredAt.getTime() !== current.occurredAt.getTime();

  if (financialChanged) {
    // refund 重建分錄時取回既有 link 的原交易（link 本身不重建）
    let originalTransactionId: string | undefined;
    if (current.type === 'refund') {
      const [link] = await tx
        .select({ fromTransactionId: transactionLinks.fromTransactionId })
        .from(transactionLinks)
        .where(and(eq(transactionLinks.toTransactionId, current.id), eq(transactionLinks.kind, 'refund')))
        .limit(1);
      if (!link) throw invalid('REFUND_MISSING_LINK', '退款交易缺少原交易連結');
      originalTransactionId = link.fromTransactionId;
    }
    const input: TransactionInput = {
      id: current.id,
      type: current.type,
      status: next.status,
      amountMinor: next.amountMinor,
      currency: current.currency,
      fromAccountId: next.fromAccountId ?? undefined,
      toAccountId: next.toAccountId ?? undefined,
      categoryAccountId: next.categoryAccountId ?? undefined,
      originalTransactionId,
      merchantRaw: next.merchantRaw ?? undefined,
      note: next.note ?? undefined,
      occurredAt: next.occurredAt.toISOString(),
      source: current.source,
    };
    const infos = await loadAccountInfos(
      tx,
      user.id,
      [input.fromAccountId, input.toAccountId, input.categoryAccountId].filter(typeofv),
    );
    const posting = buildPosting(input, infos, user.ledgerTimeZone);
    await tx
      .update(journalEntries)
      .set({ deletedAt: new Date() })
      .where(and(eq(journalEntries.transactionId, current.id), isNull(journalEntries.deletedAt)));
    const entryId = newId();
    await tx.insert(journalEntries).values({
      id: entryId,
      userId: user.id,
      entryDate: posting.entry.entryDate,
      description: posting.entry.description,
      transactionId: current.id,
    });
    await tx.insert(journalLines).values(
      posting.entry.lines.map((line, i) => ({
        id: newId(),
        entryId,
        lineNo: i + 1,
        accountId: line.accountId,
        amountMinor: line.amountMinor,
        currency: line.currency,
      })),
    );
  }

  await tx.update(transactions).set(next).where(eq(transactions.id, current.id));
  await audit(tx, user.id, 'transactions', m.entityId, 'update', current, { ...current, ...next }, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: next.version };
}

async function deleteTransaction(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const base = requireBaseVersion(m);
  const [current] = await tx
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, m.entityId), eq(transactions.userId, user.id), isNull(transactions.deletedAt)))
    .limit(1);
  if (!current) throw invalid('ACCOUNT_NOT_FOUND', '交易不存在');
  checkVersion(current, base, current);
  const now = new Date();
  const next = { deletedAt: now, version: current.version + 1, updatedAt: now };
  await tx.update(transactions).set(next).where(eq(transactions.id, current.id));
  await tx
    .update(journalEntries)
    .set({ deletedAt: now })
    .where(and(eq(journalEntries.transactionId, current.id), isNull(journalEntries.deletedAt)));
  await audit(tx, user.id, 'transactions', m.entityId, 'delete', current, { ...current, ...next }, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: next.version };
}

// ---------- recurring_rules / expected_transactions ----------

function scheduleFromRow(row: {
  freq: 'weekly' | 'monthly' | 'yearly' | 'custom_days';
  interval: number;
  dayOfMonth: number | null;
  month: number | null;
  customEveryDays: number | null;
}): RecurringSchedule {
  return {
    freq: row.freq,
    interval: row.interval,
    dayOfMonth: row.dayOfMonth ?? undefined,
    month: row.month ?? undefined,
    customEveryDays: row.customEveryDays ?? undefined,
  };
}

async function materializeExpected(
  tx: Db,
  user: MutationUser,
  rule: { id: string; nextExpectedDate: string; amountMinor: bigint | null; currency: string; accountId: string },
  mutationId: string | null,
): Promise<void> {
  const [existing] = await tx
    .select({ id: expectedTransactions.id })
    .from(expectedTransactions)
    .where(
      and(
        eq(expectedTransactions.ruleId, rule.id),
        eq(expectedTransactions.expectedDate, rule.nextExpectedDate),
        isNull(expectedTransactions.deletedAt),
      ),
    )
    .limit(1);
  if (existing) return;
  const id = newId();
  await tx.insert(expectedTransactions).values({
    id,
    userId: user.id,
    ruleId: rule.id,
    expectedDate: rule.nextExpectedDate,
    amountMinor: rule.amountMinor,
    currency: rule.currency,
    accountId: rule.accountId,
    status: 'scheduled',
  });
  await audit(tx, user.id, 'expected_transactions', id, 'create', null, { ruleId: rule.id, expectedDate: rule.nextExpectedDate }, mutationId);
  await recordChange(tx, user.id, 'expected_transactions', id, 1);
}

/** 定期定額（Q18 圈存式）：驗證投資帳戶與標的屬本使用者，回傳交割戶＝扣款帳戶。 */
async function resolveInvestRule(
  tx: Db,
  user: MutationUser,
  p: { investmentAccountId?: string | null; securityId?: string | null; amountMinor?: bigint | null },
): Promise<{ accountId: string; investmentAccountId: string; securityId: string }> {
  if (!p.investmentAccountId || !p.securityId) throw invalid('ACCOUNT_NOT_FOUND', '定期定額要選投資帳戶與標的');
  if (p.amountMinor == null) throw invalid('AMOUNT_INVALID', '定期定額要填預估金額（先圈存，確認時再填實際成交）');
  const [inv] = await tx
    .select()
    .from(investmentAccounts)
    .where(and(eq(investmentAccounts.id, p.investmentAccountId), eq(investmentAccounts.userId, user.id), isNull(investmentAccounts.deletedAt)))
    .limit(1);
  if (!inv) throw invalid('ACCOUNT_NOT_FOUND', '找不到投資帳戶');
  const [sec] = await tx
    .select({ id: securities.id })
    .from(securities)
    .where(and(eq(securities.id, p.securityId), eq(securities.userId, user.id), isNull(securities.deletedAt)))
    .limit(1);
  if (!sec) throw invalid('ACCOUNT_NOT_FOUND', '找不到投資標的');
  return { accountId: inv.settlementAccountId, investmentAccountId: inv.id, securityId: sec.id };
}

async function createRecurringRule(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const p = m.payload as unknown as RecurringRuleCreatePayload;
  validateSchedule(p.schedule);
  currencyExponent(p.currency);
  parseCivilDate(p.nextExpectedDate);
  const kind = p.kind ?? 'expense';
  let accountId = p.accountId;
  let invest: { investmentAccountId: string; securityId: string } | null = null;
  if (kind === 'invest_buy') {
    const resolved = await resolveInvestRule(tx, user, p);
    accountId = resolved.accountId;
    invest = resolved;
  }
  if (!accountId) throw invalid('ACCOUNT_NOT_FOUND', '扣款帳戶不存在');
  const infos = await loadAccountInfos(tx, user.id, [accountId, ...(p.categoryAccountId ? [p.categoryAccountId] : [])]);
  const account = infos.get(accountId);
  if (!account || account.deletedAt) throw invalid('ACCOUNT_NOT_FOUND', '扣款帳戶不存在');
  if (p.categoryAccountId) {
    const category = infos.get(p.categoryAccountId);
    if (!category || category.subtype !== 'category_expense') {
      throw invalid('ACCOUNT_KIND_INVALID', '分類必須是支出分類');
    }
  }
  const row = {
    id: m.entityId,
    userId: user.id,
    name: p.name,
    freq: p.schedule.freq,
    interval: p.schedule.interval,
    dayOfMonth: p.schedule.dayOfMonth ?? null,
    month: p.schedule.month ?? null,
    customEveryDays: p.schedule.customEveryDays ?? null,
    amountMinor: p.amountMinor ?? null,
    currency: p.currency,
    amountToleranceMinor: p.amountToleranceMinor,
    dateToleranceDays: p.dateToleranceDays,
    accountId,
    categoryAccountId: p.categoryAccountId ?? null,
    merchantHint: p.merchantHint ?? null,
    kind,
    investmentAccountId: invest?.investmentAccountId ?? null,
    securityId: invest?.securityId ?? null,
    active: p.active,
    nextExpectedDate: p.nextExpectedDate,
  };
  await tx.insert(recurringRules).values(row);
  await audit(tx, user.id, 'recurring_rules', m.entityId, 'create', null, row, m.mutationId);
  if (p.active) {
    await materializeExpected(tx, user, { id: m.entityId, nextExpectedDate: p.nextExpectedDate, amountMinor: p.amountMinor ?? null, currency: p.currency, accountId }, m.mutationId);
  }
  return { mutationId: m.mutationId, result: 'applied', version: 1 };
}

async function updateRecurringRule(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const p = m.payload as unknown as Partial<RecurringRuleCreatePayload>;
  const base = requireBaseVersion(m);
  const [current] = await tx
    .select()
    .from(recurringRules)
    .where(and(eq(recurringRules.id, m.entityId), eq(recurringRules.userId, user.id), isNull(recurringRules.deletedAt)))
    .limit(1);
  if (!current) throw invalid('ACCOUNT_NOT_FOUND', '週期規則不存在');
  checkVersion(current, base, current);

  const schedule = p.schedule ?? scheduleFromRow(current);
  validateSchedule(schedule);
  if (p.nextExpectedDate) parseCivilDate(p.nextExpectedDate);
  if (p.kind && p.kind !== current.kind) throw invalid('ACCOUNT_KIND_INVALID', '規則種類建立後不能改，請另建新規則');

  let accountId = p.accountId ?? current.accountId;
  let investFields = { investmentAccountId: current.investmentAccountId, securityId: current.securityId };
  if (current.kind === 'invest_buy') {
    const amountAfter = p.amountMinor === undefined ? current.amountMinor : p.amountMinor;
    const resolved = await resolveInvestRule(tx, user, {
      investmentAccountId: p.investmentAccountId === undefined ? current.investmentAccountId : p.investmentAccountId,
      securityId: p.securityId === undefined ? current.securityId : p.securityId,
      amountMinor: amountAfter,
    });
    accountId = resolved.accountId;
    investFields = { investmentAccountId: resolved.investmentAccountId, securityId: resolved.securityId };
  }

  const next = {
    name: p.name ?? current.name,
    freq: schedule.freq,
    interval: schedule.interval,
    dayOfMonth: schedule.dayOfMonth ?? null,
    month: schedule.month ?? null,
    customEveryDays: schedule.customEveryDays ?? null,
    amountMinor: p.amountMinor === undefined ? current.amountMinor : p.amountMinor,
    amountToleranceMinor: p.amountToleranceMinor ?? current.amountToleranceMinor,
    dateToleranceDays: p.dateToleranceDays ?? current.dateToleranceDays,
    accountId,
    categoryAccountId: p.categoryAccountId === undefined ? current.categoryAccountId : p.categoryAccountId,
    merchantHint: p.merchantHint === undefined ? current.merchantHint : p.merchantHint,
    ...investFields,
    active: p.active ?? current.active,
    nextExpectedDate: p.nextExpectedDate ?? current.nextExpectedDate,
    version: current.version + 1,
    updatedAt: new Date(),
  };
  await tx.update(recurringRules).set(next).where(eq(recurringRules.id, current.id));

  // 開著的 scheduled expected 跟著規則走
  const [openExpected] = await tx
    .select()
    .from(expectedTransactions)
    .where(
      and(
        eq(expectedTransactions.ruleId, current.id),
        eq(expectedTransactions.status, 'scheduled'),
        isNull(expectedTransactions.deletedAt),
      ),
    )
    .limit(1);
  if (next.active) {
    if (openExpected) {
      const derived = {
        expectedDate: next.nextExpectedDate,
        amountMinor: next.amountMinor,
        accountId: next.accountId,
        version: openExpected.version + 1,
        updatedAt: new Date(),
      };
      await tx
        .update(expectedTransactions)
        .set(derived)
        .where(eq(expectedTransactions.id, openExpected.id));
      await audit(tx, user.id, 'expected_transactions', openExpected.id, 'sync_from_rule', openExpected, { ...openExpected, ...derived }, m.mutationId);
      await recordChange(tx, user.id, 'expected_transactions', openExpected.id, derived.version);
    } else {
      await materializeExpected(tx, user, { id: current.id, nextExpectedDate: next.nextExpectedDate, amountMinor: next.amountMinor, currency: current.currency, accountId: next.accountId }, m.mutationId);
    }
  } else if (openExpected) {
    const derived = { status: 'skipped' as const, version: openExpected.version + 1, updatedAt: new Date() };
    await tx
      .update(expectedTransactions)
      .set(derived)
      .where(eq(expectedTransactions.id, openExpected.id));
    await audit(tx, user.id, 'expected_transactions', openExpected.id, 'skip_from_rule', openExpected, { ...openExpected, ...derived }, m.mutationId);
    await recordChange(tx, user.id, 'expected_transactions', openExpected.id, derived.version);
  }
  await audit(tx, user.id, 'recurring_rules', m.entityId, 'update', current, { ...current, ...next }, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: next.version };
}

async function deleteRecurringRule(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const base = requireBaseVersion(m);
  const [current] = await tx
    .select()
    .from(recurringRules)
    .where(and(eq(recurringRules.id, m.entityId), eq(recurringRules.userId, user.id), isNull(recurringRules.deletedAt)))
    .limit(1);
  if (!current) throw invalid('ACCOUNT_NOT_FOUND', '週期規則不存在');
  checkVersion(current, base, current);
  const now = new Date();
  const next = { deletedAt: now, active: false, version: current.version + 1, updatedAt: now };
  await tx.update(recurringRules).set(next).where(eq(recurringRules.id, current.id));
  const openExpected = await tx
    .select()
    .from(expectedTransactions)
    .where(and(eq(expectedTransactions.ruleId, current.id), eq(expectedTransactions.status, 'scheduled'), isNull(expectedTransactions.deletedAt)));
  const deletedExpected = await tx
    .update(expectedTransactions)
    .set({ deletedAt: now, version: sql`${expectedTransactions.version} + 1`, updatedAt: now })
    .where(
      and(
        eq(expectedTransactions.ruleId, current.id),
        eq(expectedTransactions.status, 'scheduled'),
        isNull(expectedTransactions.deletedAt),
      ),
    )
    .returning({ id: expectedTransactions.id, version: expectedTransactions.version });
  for (const changed of deletedExpected) {
    const before = openExpected.find((item) => item.id === changed.id);
    await audit(tx, user.id, 'expected_transactions', changed.id, 'delete_from_rule', before ?? null, { ...(before ?? {}), deletedAt: now, version: changed.version }, m.mutationId);
    await recordChange(tx, user.id, 'expected_transactions', changed.id, changed.version);
  }
  await audit(tx, user.id, 'recurring_rules', m.entityId, 'delete', current, { ...current, ...next }, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: next.version };
}

async function updateExpectedTransaction(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const p = m.payload as unknown as ExpectedUpdatePayload;
  const base = requireBaseVersion(m);
  const [current] = await tx
    .select()
    .from(expectedTransactions)
    .where(
      and(eq(expectedTransactions.id, m.entityId), eq(expectedTransactions.userId, user.id), isNull(expectedTransactions.deletedAt)),
    )
    .limit(1);
  if (!current) throw invalid('ACCOUNT_NOT_FOUND', '預計交易不存在');
  checkVersion(current, base, current);

  assertExpectedTransition(current.status, p.status);
  if (p.matchedTransactionId) {
    const [txn] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.id, p.matchedTransactionId), eq(transactions.userId, user.id), isNull(transactions.deletedAt)))
      .limit(1);
    if (!txn) throw invalid('ACCOUNT_NOT_FOUND', '對應的實際交易不存在');
  }

  const next = {
    status: p.status,
    matchedTransactionId: p.matchedTransactionId === undefined ? current.matchedTransactionId : p.matchedTransactionId,
    version: current.version + 1,
    updatedAt: new Date(),
  };
  await tx.update(expectedTransactions).set(next).where(eq(expectedTransactions.id, current.id));
  await audit(tx, user.id, 'expected_transactions', m.entityId, 'update', current, { ...current, ...next }, m.mutationId);

  // 確認/略過後推進規則到下一期（RECUR-5 M1 手動流程）
  if ((p.status === 'confirmed' || p.status === 'skipped') && current.ruleId) {
    const [rule] = await tx
      .select()
      .from(recurringRules)
      .where(and(eq(recurringRules.id, current.ruleId), isNull(recurringRules.deletedAt)))
      .limit(1);
    if (rule && rule.active) {
      const nextDate = formatCivilDate(nextExpectedDate(scheduleFromRow(rule), parseCivilDate(current.expectedDate)));
      const derivedRule = { nextExpectedDate: nextDate, version: rule.version + 1, updatedAt: new Date() };
      await tx
        .update(recurringRules)
        .set(derivedRule)
        .where(eq(recurringRules.id, rule.id));
      await audit(tx, user.id, 'recurring_rules', rule.id, 'advance_from_expected', rule, { ...rule, ...derivedRule }, m.mutationId);
      await recordChange(tx, user.id, 'recurring_rules', rule.id, derivedRule.version);
      await materializeExpected(
        tx,
        user,
        { id: rule.id, nextExpectedDate: nextDate, amountMinor: rule.amountMinor, currency: rule.currency, accountId: rule.accountId },
        m.mutationId,
      );
    }
  }
  return { mutationId: m.mutationId, result: 'applied', version: next.version };
}

// ---------- investment_accounts（M4：一次建立交割現金帳戶 + 投資資產帳戶配對）----------

async function createInvestmentAccount(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const p = m.payload as unknown as InvestmentAccountCreatePayload;
  currencyExponent(p.currency);
  const settlementId = newId();
  const assetId = newId();
  const institution = p.institution ?? null;
  const settlementRow = { id: settlementId, userId: user.id, kind: 'asset' as const, subtype: 'brokerage_settlement' as const, name: `${p.name} 交割`, institution, currency: p.currency };
  const assetRow = { id: assetId, userId: user.id, kind: 'asset' as const, subtype: 'investment_asset' as const, name: p.name, institution, currency: p.currency };
  await tx.insert(accounts).values(settlementRow);
  await tx.insert(accounts).values(assetRow);
  const row = { id: m.entityId, userId: user.id, name: p.name, currency: p.currency, settlementAccountId: settlementId, assetAccountId: assetId };
  await tx.insert(investmentAccounts).values(row);
  await audit(tx, user.id, 'accounts', settlementId, 'create', null, settlementRow, m.mutationId);
  await audit(tx, user.id, 'accounts', assetId, 'create', null, assetRow, m.mutationId);
  await audit(tx, user.id, 'investment_accounts', m.entityId, 'create', null, row, m.mutationId);
  await recordChange(tx, user.id, 'accounts', settlementId, 1);
  await recordChange(tx, user.id, 'accounts', assetId, 1);
  return { mutationId: m.mutationId, result: 'applied', version: 1 };
}

async function updateInvestmentAccount(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const p = m.payload as unknown as InvestmentAccountUpdatePayload;
  const base = requireBaseVersion(m);
  const [current] = await tx
    .select()
    .from(investmentAccounts)
    .where(and(eq(investmentAccounts.id, m.entityId), eq(investmentAccounts.userId, user.id), isNull(investmentAccounts.deletedAt)))
    .limit(1);
  if (!current) throw invalid('ACCOUNT_NOT_FOUND', '投資帳戶不存在');
  checkVersion(current, base, current);
  const next = { name: p.name ?? current.name, version: current.version + 1, updatedAt: new Date() };
  await tx.update(investmentAccounts).set(next).where(eq(investmentAccounts.id, current.id));
  await audit(tx, user.id, 'investment_accounts', m.entityId, 'update', current, { ...current, ...next }, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: next.version };
}

async function deleteInvestmentAccount(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const base = requireBaseVersion(m);
  const [current] = await tx
    .select()
    .from(investmentAccounts)
    .where(and(eq(investmentAccounts.id, m.entityId), eq(investmentAccounts.userId, user.id), isNull(investmentAccounts.deletedAt)))
    .limit(1);
  if (!current) throw invalid('ACCOUNT_NOT_FOUND', '投資帳戶不存在');
  checkVersion(current, base, current);
  const [used] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(
      and(
        or(eq(journalLines.accountId, current.settlementAccountId), eq(journalLines.accountId, current.assetAccountId)),
        isNull(journalEntries.deletedAt),
      ),
    );
  if ((used?.n ?? 0) > 0) throw invalid('ACCOUNT_IN_USE', '此投資帳戶已有帳務紀錄，無法刪除');
  const next = { deletedAt: new Date(), version: current.version + 1, updatedAt: new Date() };
  await tx.update(investmentAccounts).set(next).where(eq(investmentAccounts.id, current.id));
  await audit(tx, user.id, 'investment_accounts', m.entityId, 'delete', current, { ...current, ...next }, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: next.version };
}

// ---------- securities（M4：使用者手動維護的標的主檔）----------

async function createSecurity(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const p = m.payload as unknown as SecurityCreatePayload;
  currencyExponent(p.currency);
  const row = { id: m.entityId, userId: user.id, symbol: p.symbol, name: p.name, market: p.market, currency: p.currency, kind: p.kind };
  await tx.insert(securities).values(row);
  await audit(tx, user.id, 'securities', m.entityId, 'create', null, row, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: 1 };
}

async function updateSecurity(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const p = m.payload as unknown as SecurityUpdatePayload;
  const base = requireBaseVersion(m);
  const [current] = await tx
    .select()
    .from(securities)
    .where(and(eq(securities.id, m.entityId), eq(securities.userId, user.id), isNull(securities.deletedAt)))
    .limit(1);
  if (!current) throw invalid('ACCOUNT_NOT_FOUND', '標的不存在');
  checkVersion(current, base, current);
  if (p.currency) currencyExponent(p.currency);
  const nextCurrency = p.currency ?? current.currency;
  if (nextCurrency !== current.currency) {
    const linkedAccounts = await tx
      .select({ currency: accounts.currency })
      .from(holdings)
      .innerJoin(accounts, eq(holdings.assetAccountId, accounts.id))
      .where(and(eq(holdings.securityId, current.id), eq(holdings.userId, user.id)));
    if (linkedAccounts.some((row) => row.currency !== nextCurrency)) {
      throw invalid(
        'SECURITY_CURRENCY_MISMATCH',
        `這個標的已有 ${linkedAccounts[0]?.currency ?? current.currency} 持倉；請先在 ${nextCurrency} 投資帳戶重新登記，不能直接改幣別`,
      );
    }
    const [priced] = await tx
      .select({ id: marketPrices.id })
      .from(marketPrices)
      .where(eq(marketPrices.securityId, current.id))
      .limit(1);
    if (priced) {
      throw invalid('SECURITY_CURRENCY_PRICED', '這個標的已有歷史報價，不能直接改變報價幣別；請建立正確幣別的新標的');
    }
  }
  const next = {
    symbol: p.symbol ?? current.symbol,
    name: p.name ?? current.name,
    market: p.market ?? current.market,
    currency: nextCurrency,
    kind: p.kind ?? current.kind,
    version: current.version + 1,
    updatedAt: new Date(),
  };
  await tx.update(securities).set(next).where(eq(securities.id, current.id));
  await audit(tx, user.id, 'securities', m.entityId, 'update', current, { ...current, ...next }, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: next.version };
}

async function deleteSecurity(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const base = requireBaseVersion(m);
  const [current] = await tx
    .select()
    .from(securities)
    .where(and(eq(securities.id, m.entityId), eq(securities.userId, user.id), isNull(securities.deletedAt)))
    .limit(1);
  if (!current) throw invalid('ACCOUNT_NOT_FOUND', '標的不存在');
  checkVersion(current, base, current);
  const [held] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(holdings)
    .where(and(eq(holdings.securityId, current.id), sql`${holdings.quantityMicro} > 0`));
  if ((held?.n ?? 0) > 0) throw new DomainError('SECURITY_IN_USE', '仍有持倉引用此標的，無法刪除');
  const next = { deletedAt: new Date(), version: current.version + 1, updatedAt: new Date() };
  await tx.update(securities).set(next).where(eq(securities.id, current.id));
  await audit(tx, user.id, 'securities', m.entityId, 'delete', current, { ...current, ...next }, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: next.version };
}

// ---------- market_prices / exchange_rates（M4：append-only 價格與匯率快照，ADR-008）----------

async function createMarketPrice(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const p = m.payload as unknown as MarketPriceCreatePayload;
  const [security] = await tx
    .select({ id: securities.id })
    .from(securities)
    .where(and(eq(securities.id, p.securityId), eq(securities.userId, user.id), isNull(securities.deletedAt)))
    .limit(1);
  if (!security) throw invalid('ACCOUNT_NOT_FOUND', '找不到標的');
  const row = { id: m.entityId, securityId: p.securityId, price: p.price, asOf: new Date(p.asOf), source: p.source };
  await tx.insert(marketPrices).values(row);
  await audit(tx, user.id, 'market_prices', m.entityId, 'create', null, row, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: 1 };
}

/** 報價 provider 的唯一寫入路徑：驗證標的歸屬、保存快照、audit log 與同步 change feed。 */
export async function recordProviderMarketPrice(
  db: Db,
  input: { userId: string; securityId: string; price: string; asOf: Date },
): Promise<{ id: string; price: string; asOf: Date; source: 'provider' }> {
  return db.transaction(async (tx) => {
    const [security] = await tx
      .select({ id: securities.id })
      .from(securities)
      .where(and(eq(securities.id, input.securityId), eq(securities.userId, input.userId), isNull(securities.deletedAt)))
      .limit(1);
    if (!security) throw invalid('ACCOUNT_NOT_FOUND', '找不到標的');
    const row = { id: newId(), securityId: input.securityId, price: input.price, asOf: input.asOf, source: 'provider' as const };
    await tx.insert(marketPrices).values(row);
    await audit(tx as unknown as Db, input.userId, 'market_prices', row.id, 'create', null, row, null);
    await recordChange(tx as unknown as Db, input.userId, 'market_prices', row.id, 1);
    return row;
  });
}

async function createExchangeRate(tx: Db, user: MutationUser, m: MutationInput): Promise<MutationOutcome> {
  const p = m.payload as unknown as ExchangeRateCreatePayload;
  currencyExponent(p.base);
  currencyExponent(p.quote);
  const row = { id: m.entityId, base: p.base, quote: p.quote, rate: p.rate, asOf: new Date(p.asOf), source: p.source };
  await tx.insert(exchangeRates).values(row);
  await audit(tx, user.id, 'exchange_rates', m.entityId, 'create', null, row, m.mutationId);
  return { mutationId: m.mutationId, result: 'applied', version: 1 };
}
