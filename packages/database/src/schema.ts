import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/**
 * M1 核心表（DATA_MODEL §2、§3）。DB schema: okane_dokoitta。
 * 慣例：金額 bigint 最小單位；*_date = date（民用）；*_at = timestamptz（UTC）；
 * 軟刪除 deleted_at；可同步實體帶 version（樂觀鎖）。
 */
export const okane = pgSchema('okane_dokoitta');

export const accountKind = okane.enum('account_kind', ['asset', 'liability', 'income', 'expense', 'equity']);
export const accountSubtype = okane.enum('account_subtype', [
  'cash',
  'bank',
  'digital',
  'e_wallet',
  'credit_card',
  'brokerage_settlement',
  'investment_asset',
  'other_asset',
  'other_liability',
  'category_income',
  'category_expense',
  'opening_balance',
]);
export const cardStatus = okane.enum('card_status', ['active', 'frozen', 'cancelled']);
export const transactionType = okane.enum('transaction_type', [
  'expense',
  'income',
  'transfer',
  'card_payment',
  'refund',
  'invest_buy',
  'invest_sell',
  'dividend',
  'fee',
  'tax',
  'adjustment',
]);
export const transactionStatus = okane.enum('transaction_status', [
  'draft',
  'expected',
  'pending',
  'posted',
  'cancelled',
  'disputed',
]);
export const transactionSource = okane.enum('transaction_source', [
  'manual',
  'import',
  'recurring',
  'discord_draft',
  'patch',
]);
export const linkKind = okane.enum('transaction_link_kind', [
  'refund',
  'installment_parent',
  'fx_pair',
  'duplicate_of',
  'payment_for_statement',
  'correction',
]);
export const recurFreq = okane.enum('recur_freq', ['weekly', 'monthly', 'yearly', 'custom_days']);
/** 週期規則種類：expense＝週期支出；invest_buy＝定期定額（圈存預估額，確認時填實際成交，Q18 拍板）。 */
export const recurKind = okane.enum('recur_kind', ['expense', 'invest_buy']);
export const expectedStatus = okane.enum('expected_status', ['scheduled', 'matched', 'confirmed', 'missed', 'skipped']);
export const auditActor = okane.enum('audit_actor', ['user', 'system', 'discord', 'patch', 'sync']);
export const mutationOp = okane.enum('mutation_op', ['create', 'update', 'delete']);
export const mutationResult = okane.enum('mutation_result', [
  'applied',
  'rejected_conflict',
  'rejected_invalid',
  'duplicate',
]);
export const rateSource = okane.enum('rate_source', ['manual', 'provider']);
export const securityKind = okane.enum('security_kind', ['stock', 'etf']);
export const importFileStatus = okane.enum('import_file_status', ['uploaded', 'parsed', 'failed', 'purged']);
export const statementStatus = okane.enum('statement_status', ['open', 'closed', 'due', 'paid', 'superseded']);
export const auditSessionStatus = okane.enum('audit_session_status', ['created', 'parsing', 'matching', 'reviewing', 'completed', 'archived', 'superseded']);
export const auditCandidateKind = okane.enum('audit_candidate_kind', [
  'match', 'missing_in_ledger', 'missing_in_statement', 'amount_mismatch', 'date_mismatch',
  'wrong_card', 'duplicate', 'refund_unlinked', 'deferred_posting', 'installment_issue', 'unresolved_difference',
]);
export const candidateDecision = okane.enum('candidate_decision', ['pending', 'accepted', 'rejected']);
export const patchKind = okane.enum('patch_kind', [
  'create_transaction', 'update_transaction', 'merge_duplicates', 'link_refund',
  'assign_statement', 'create_expected', 'adjust_amount', 'acknowledge_unresolved',
]);
export const patchOrigin = okane.enum('patch_origin', ['rule', 'ai', 'user']);
export const patchStatus = okane.enum('patch_status', ['proposed', 'accepted', 'rejected', 'applied', 'failed']);
export const aliasSource = okane.enum('alias_source', ['user', 'rule', 'ai']);
export const jobStatus = okane.enum('job_status', ['queued', 'running', 'completed', 'failed']);
export const notificationPrivacyMode = okane.enum('notification_privacy_mode', ['full', 'fuzzy', 'anomaly_only', 'hidden']);
export const notificationChannel = okane.enum('notification_channel', ['discord', 'web_push']);

// ---------- 使用者與登入（M1 最簡；Passkey M2）----------

export const users = okane.table('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name'),
  ledgerTimeZone: text('ledger_time_zone').notNull().default('Asia/Taipei'),
  /** 淨資產一覽的換算基準幣別（INVESTMENT_MODEL §4，M4） */
  baseCurrency: char('base_currency', { length: 3 }).notNull().default('TWD'),
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const instanceState = okane.table('instance_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authCredentials = okane.table('auth_credentials', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  kind: text('kind').notNull(), // 'password'（M2: 'passkey'）
  passwordHash: text('password_hash'), // argon2id
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const passkeys = okane.table(
  'passkeys',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    credentialId: text('credential_id').notNull(),
    publicKey: text('public_key').notNull(), // base64url COSE public key
    counter: bigint('counter', { mode: 'bigint' }).notNull().default(sql`0`),
    transports: text('transports').array().notNull().default([]),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('passkeys_credential_id_idx').on(t.credentialId), index('passkeys_user_idx').on(t.userId)],
);

export const recoveryCodes = okane.table(
  'recovery_codes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    codeHash: text('code_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [index('recovery_codes_user_idx').on(t.userId)],
);

export const authChallenges = okane.table(
  'auth_challenges',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').references(() => users.id),
    kind: text('kind').notNull(),
    challenge: text('challenge').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_challenges_expiry_idx').on(t.expiresAt)],
);

export const totpCredentials = okane.table('totp_credentials', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id).unique(),
  encryptedSecret: text('encrypted_secret').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const registrationInvites = okane.table(
  'registration_invites',
  {
    id: uuid('id').primaryKey(),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    usedByUserId: uuid('used_by_user_id').references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('registration_invites_code_hash_idx').on(t.codeHash)],
);

export const syncDevices = okane.table(
  'sync_devices',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    name: text('name').notNull(),
    platform: text('platform').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('sync_devices_user_idx').on(t.userId)],
);

export const sessions = okane.table(
  'sessions',
  {
    // session token 只存 SHA-256 雜湊；原始 token 只在 cookie
    tokenHash: text('token_hash').primaryKey(),
    publicId: uuid('public_id').notNull().unique(),
    userId: uuid('user_id').notNull().references(() => users.id),
    deviceId: uuid('device_id').references(() => syncDevices.id),
    csrfToken: text('csrf_token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

// ---------- 帳戶 ----------

export const accountGroups = okane.table('account_groups', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const accounts = okane.table(
  'accounts',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    kind: accountKind('kind').notNull(),
    subtype: accountSubtype('subtype').notNull(),
    name: text('name').notNull(),
    /** 所屬機構（銀行／電支業者，選填）：清單、記帳 chip 顯示用；信用卡的發卡行仍在 credit_cards.issuer */
    institution: text('institution'),
    currency: char('currency', { length: 3 }).notNull(),
    groupId: uuid('group_id').references(() => accountGroups.id),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('accounts_user_idx').on(t.userId),
    uniqueIndex('accounts_user_opening_balance_unique')
      .on(t.userId)
      .where(sql`${t.subtype} = 'opening_balance'`),
  ],
);

export const creditLimitGroups = okane.table('credit_limit_groups', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  issuer: text('issuer').notNull(),
  limitMinor: bigint('limit_minor', { mode: 'bigint' }).notNull(),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const creditCards = okane.table('credit_cards', {
  accountId: uuid('account_id').primaryKey().references(() => accounts.id),
  issuer: text('issuer').notNull(),
  cardName: text('card_name').notNull(),
  last4: char('last4', { length: 4 }), // ACCT-7：永不存完整卡號（schema 層就沒有欄位）；選填，避免要求使用者輸入卡號相關資訊的資安疑慮
  creditLimitMinor: bigint('credit_limit_minor', { mode: 'bigint' }),
  limitGroupId: uuid('limit_group_id').references(() => creditLimitGroups.id),
  statementDay: smallint('statement_day').notNull(),
  dueDay: smallint('due_day').notNull(),
  autopayDay: smallint('autopay_day'),
  autopayAccountId: uuid('autopay_account_id').references(() => accounts.id),
  status: cardStatus('status').notNull().default('active'),
});

// ---------- 複式帳本 ----------

export const transactions = okane.table(
  'transactions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    type: transactionType('type').notNull(),
    status: transactionStatus('status').notNull(),
    needsReview: boolean('needs_review').notNull().default(false),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    fromAccountId: uuid('from_account_id').references(() => accounts.id),
    toAccountId: uuid('to_account_id').references(() => accounts.id),
    categoryAccountId: uuid('category_account_id').references(() => accounts.id),
    merchantRaw: text('merchant_raw'),
    merchantNormalized: text('merchant_normalized'),
    note: text('note'),
    // 日期群（TXN-1）
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    statementId: uuid('statement_id').references((): AnyPgColumn => statements.id),
    statementDate: date('statement_date'),
    dueDate: date('due_date'),
    scheduledPaymentAt: timestamp('scheduled_payment_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    installmentCurrent: smallint('installment_current'),
    installmentTotal: smallint('installment_total'),
    recurringRuleId: uuid('recurring_rule_id'),
    expectedTransactionId: uuid('expected_transaction_id'),
    // 投資買賣/股息（M4）：標的與數量；quantity 固定 6 位小數精度（micro units，domain/investments.ts）
    securityId: uuid('security_id').references((): AnyPgColumn => securities.id),
    quantityMicro: bigint('quantity_micro', { mode: 'bigint' }),
    source: transactionSource('source').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('transactions_user_occurred_idx').on(t.userId, t.occurredAt),
    index('transactions_user_from_idx').on(t.userId, t.fromAccountId),
    index('transactions_user_to_idx').on(t.userId, t.toAccountId),
  ],
);

export const journalEntries = okane.table(
  'journal_entries',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    entryDate: date('entry_date').notNull(),
    description: text('description').notNull(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // 交易被修改時舊 entry 軟刪除、產生新 entry（不物理刪除帳務資料）
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('journal_entries_txn_idx').on(t.transactionId), index('journal_entries_user_idx').on(t.userId)],
);

export const journalLines = okane.table(
  'journal_lines',
  {
    id: uuid('id').primaryKey(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id),
    lineNo: smallint('line_no').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    // 有號：借正貸負（規約由 packages/domain 以測試釘死）
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
  },
  (t) => [index('journal_lines_entry_idx').on(t.entryId), index('journal_lines_account_idx').on(t.accountId)],
);

export const transactionLinks = okane.table('transaction_links', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  kind: linkKind('kind').notNull(),
  fromTransactionId: uuid('from_transaction_id')
    .notNull()
    .references(() => transactions.id),
  toTransactionId: uuid('to_transaction_id')
    .notNull()
    .references(() => transactions.id),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------- 週期規則與預計交易 ----------

export const recurringRules = okane.table('recurring_rules', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  freq: recurFreq('freq').notNull(),
  interval: smallint('interval').notNull().default(1),
  dayOfMonth: smallint('day_of_month'),
  month: smallint('month'),
  customEveryDays: smallint('custom_every_days'),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }), // null = 浮動金額
  currency: char('currency', { length: 3 }).notNull(),
  amountToleranceMinor: bigint('amount_tolerance_minor', { mode: 'bigint' }).notNull().default(sql`0`),
  dateToleranceDays: smallint('date_tolerance_days').notNull().default(3),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  categoryAccountId: uuid('category_account_id').references(() => accounts.id),
  merchantHint: text('merchant_hint'),
  // 定期定額（kind=invest_buy）：買哪個券商帳戶、哪支標的；accountId 此時＝交割戶（server 端解析）
  kind: recurKind('kind').notNull().default('expense'),
  investmentAccountId: uuid('investment_account_id').references(() => investmentAccounts.id),
  securityId: uuid('security_id').references(() => securities.id),
  active: boolean('active').notNull().default(true),
  nextExpectedDate: date('next_expected_date').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const expectedTransactions = okane.table(
  'expected_transactions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    ruleId: uuid('rule_id').references(() => recurringRules.id),
    expectedDate: date('expected_date').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }), // null = 浮動
    currency: char('currency', { length: 3 }).notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    status: expectedStatus('status').notNull().default('scheduled'),
    matchedTransactionId: uuid('matched_transaction_id').references(() => transactions.id),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('expected_rule_date_unique').on(t.ruleId, t.expectedDate)],
);

// ---------- 匯率（M1 模型 / M4 一覽）----------

export const exchangeRates = okane.table('exchange_rates', {
  id: uuid('id').primaryKey(),
  base: char('base', { length: 3 }).notNull(),
  quote: char('quote', { length: 3 }).notNull(),
  rate: text('rate').notNull(), // 十進位字串；比率非金額（DATA_MODEL §5），運算在 domain money module
  asOf: timestamp('as_of', { withTimezone: true }).notNull(),
  source: rateSource('source').notNull().default('manual'),
});

// ---------- 投資與資產一覽（M4，INVESTMENT_MODEL） ----------

/** 券商：交割現金帳戶 + 投資資產帳戶配對；holdings 以 assetAccountId 分組。 */
export const investmentAccounts = okane.table(
  'investment_accounts',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    name: text('name').notNull(),
    // 顯示與下單用幣別（web 從 M4 起就依賴它，欄位卻漏建——migration 0011 補上並從交割戶回填）
    currency: char('currency', { length: 3 }).notNull().default('TWD'),
    settlementAccountId: uuid('settlement_account_id').notNull().references(() => accounts.id),
    assetAccountId: uuid('asset_account_id').notNull().references(() => accounts.id),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('investment_accounts_user_idx').on(t.userId),
    uniqueIndex('investment_accounts_asset_unique').on(t.assetAccountId),
  ],
);

/** 標的主檔：使用者手動維護的代號清單（第一版無自動下拉，ADR-008）。 */
export const securities = okane.table(
  'securities',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    symbol: text('symbol').notNull(),
    name: text('name').notNull(),
    market: text('market').notNull(), // 自由文字：TW/US/…（顯示用，非枚舉）
    currency: char('currency', { length: 3 }).notNull(),
    kind: securityKind('kind').notNull().default('stock'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('securities_user_idx').on(t.userId)],
);

/** 價格快照：附 as_of + source，一覽用「最後更新 n 天前」提醒過期（INVESTMENT_MODEL §5）。 */
export const marketPrices = okane.table(
  'market_prices',
  {
    id: uuid('id').primaryKey(),
    securityId: uuid('security_id').notNull().references(() => securities.id),
    price: text('price').notNull(), // 十進位字串，比率非金額，運算在 domain money module
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    source: rateSource('source').notNull().default('manual'),
  },
  (t) => [index('market_prices_security_asof_idx').on(t.securityId, t.asOf)],
);

/** 持倉：每個投資資產帳戶 × 標的的數量與成本基礎（平均成本法，由 invest_buy/invest_sell 交易維護，非直接寫入）。 */
export const holdings = okane.table(
  'holdings',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    assetAccountId: uuid('asset_account_id').notNull().references(() => accounts.id),
    securityId: uuid('security_id').notNull().references(() => securities.id),
    quantityMicro: bigint('quantity_micro', { mode: 'bigint' }).notNull(),
    costBasisMinor: bigint('cost_basis_minor', { mode: 'bigint' }).notNull(),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('holdings_asset_security_unique').on(t.assetAccountId, t.securityId)],
);

// ---------- 帳單匯入與審計（M3） ----------

export const importFiles = okane.table(
  'import_files',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    storagePath: text('storage_path').notNull(),
    importerId: text('importer_id'),
    status: importFileStatus('status').notNull().default('uploaded'),
    retainUntil: date('retain_until').notNull(),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('import_files_user_created_idx').on(t.userId, t.createdAt)],
);

/** 銀行同一原始檔合併多張卡時的外部帳單事實；每張卡仍各自有 statement 做審計。 */
export const statementGroups = okane.table(
  'statement_groups',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    importFileId: uuid('import_file_id').notNull().references(() => importFiles.id).unique(),
    institution: text('institution').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    statementDate: date('statement_date').notNull(),
    dueDate: date('due_date').notNull(),
    totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('statement_groups_user_date_idx').on(t.userId, t.statementDate)],
);

export const statements = okane.table(
  'statements',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    creditCardAccountId: uuid('credit_card_account_id').notNull().references(() => accounts.id),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    statementDate: date('statement_date').notNull(),
    dueDate: date('due_date').notNull(),
    totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    minimumDueMinor: bigint('minimum_due_minor', { mode: 'bigint' }),
    previousBalanceMinor: bigint('previous_balance_minor', { mode: 'bigint' }),
    status: statementStatus('status').notNull().default('closed'),
    importFileId: uuid('import_file_id').references(() => importFiles.id),
    groupId: uuid('group_id').references(() => statementGroups.id),
    auditSessionId: uuid('audit_session_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('statements_user_card_date_idx').on(t.userId, t.creditCardAccountId, t.statementDate),
    uniqueIndex('statements_group_card_unique').on(t.groupId, t.creditCardAccountId),
  ],
);

export const statementItems = okane.table(
  'statement_items',
  {
    id: uuid('id').primaryKey(),
    statementId: uuid('statement_id').notNull().references(() => statements.id),
    lineNo: integer('line_no').notNull(),
    merchantRaw: text('merchant_raw').notNull(),
    merchantNormalized: text('merchant_normalized'),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    occurredDate: date('occurred_date'),
    postedDate: date('posted_date'),
    cardLast4: char('card_last4', { length: 4 }),
    installmentCurrent: smallint('installment_current'),
    installmentTotal: smallint('installment_total'),
    raw: jsonb('raw').notNull(),
    matchedTransactionId: uuid('matched_transaction_id').references(() => transactions.id),
  },
  (t) => [uniqueIndex('statement_items_line_unique').on(t.statementId, t.lineNo)],
);

export const auditSessions = okane.table(
  'audit_sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    statementId: uuid('statement_id').notNull().references(() => statements.id),
    status: auditSessionStatus('status').notNull().default('created'),
    stats: jsonb('stats').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('audit_sessions_user_created_idx').on(t.userId, t.createdAt)],
);

export const auditCandidates = okane.table(
  'audit_candidates',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id').notNull().references(() => auditSessions.id),
    statementItemId: uuid('statement_item_id').references(() => statementItems.id),
    transactionId: uuid('transaction_id').references(() => transactions.id),
    kind: auditCandidateKind('kind').notNull(),
    score: text('score').notNull(),
    reasoningCodes: text('reasoning_codes').array().notNull().default([]),
    evidence: jsonb('evidence').notNull().default({}),
    explanation: text('explanation').notNull(),
    decision: candidateDecision('decision').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_candidates_session_idx').on(t.sessionId)],
);

export const proposedPatches = okane.table(
  'proposed_patches',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    sessionId: uuid('session_id').references(() => auditSessions.id),
    candidateId: uuid('candidate_id').references(() => auditCandidates.id),
    kind: patchKind('kind').notNull(),
    payload: jsonb('payload').notNull(),
    origin: patchOrigin('origin').notNull(),
    status: patchStatus('status').notNull().default('proposed'),
    failureCode: text('failure_code'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    appliedAuditLogId: uuid('applied_audit_log_id').references(() => auditLogs.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('proposed_patches_user_session_idx').on(t.userId, t.sessionId)],
);

export const merchantAliases = okane.table(
  'merchant_aliases',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    pattern: text('pattern').notNull(),
    normalized: text('normalized').notNull(),
    source: aliasSource('source').notNull(),
    hitCount: integer('hit_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('merchant_aliases_user_pattern_unique').on(t.userId, t.pattern)],
);

export const jobs = okane.table(
  'jobs',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').references(() => users.id),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: jobStatus('status').notNull().default('queued'),
    attempts: smallint('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('jobs_status_available_idx').on(t.status, t.availableAt)],
);

// ---------- 稽核與冪等 ----------

export const auditLogs = okane.table(
  'audit_logs',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    actor: auditActor('actor').notNull(),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    action: text('action').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    mutationId: uuid('mutation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_logs_user_entity_idx').on(t.userId, t.entity, t.entityId)],
);

export const syncMutations = okane.table('sync_mutations', {
  mutationId: uuid('mutation_id').primaryKey(), // client 產生 —— 冪等鍵（SYNC-3，M1 起）
  userId: uuid('user_id').notNull().references(() => users.id),
  deviceId: text('device_id').notNull(),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id').notNull(),
  op: mutationOp('op').notNull(),
  baseVersion: integer('base_version'),
  payload: jsonb('payload').notNull(),
  result: mutationResult('result').notNull(),
  // 首次套用後的版本：重複收到同 mutationId 時回傳首次結果用
  appliedVersion: integer('applied_version'),
  errorCode: text('error_code'),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
});

export const changeLog = okane.table(
  'change_log',
  {
    seq: bigserial('seq', { mode: 'bigint' }).primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('change_log_user_seq_idx').on(t.userId, t.seq)],
);

// ---------- Discord 整合與通知（M5，DISCORD_INTEGRATION）----------

/**
 * 帳號連結：一個 okane-dokoitta 使用者對一個 Discord 使用者。
 * OAuth 只在連結當下用一次（用 identify scope 證明使用者擁有這個 Discord 帳號），
 * 不持久保存 access/refresh token —— 之後所有操作都用 bot token（DM）或 interaction payload
 * 自帶的 discord_user_id（辨識呼叫者），沒有需要長期保存使用者 OAuth token 的操作（ADR-005）。
 */
export const discordLinks = okane.table(
  'discord_links',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id).unique(),
    discordUserId: text('discord_user_id').notNull().unique(),
    discordUsername: text('discord_username').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('discord_links_user_idx').on(t.userId)],
);

/** 反向連結（`/finance link` 從 Discord 端發起）：一次性短效 token，只存雜湊。 */
export const discordLinkTokens = okane.table('discord_link_tokens', {
  id: uuid('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  discordUserId: text('discord_user_id').notNull(),
  discordUsername: text('discord_username').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 每使用者一列：隱私模式、通道開關、quiet hours、個別事件靜音（DISCORD_INTEGRATION §5、§6）。 */
export const notificationPreferences = okane.table('notification_preferences', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  privacyMode: notificationPrivacyMode('privacy_mode').notNull().default('fuzzy'),
  discordEnabled: boolean('discord_enabled').notNull().default(true),
  webPushEnabled: boolean('web_push_enabled').notNull().default(true),
  // 分鐘數（0-1439，本地民用時間）；任一為 null＝不啟用 quiet hours
  quietHoursStartMinute: smallint('quiet_hours_start_minute'),
  quietHoursEndMinute: smallint('quiet_hours_end_minute'),
  mutedEventTypes: text('muted_event_types').array().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 已發送通知紀錄：dedup（同 dedup_key 不重發）與 cooldown（同 eventType 最小間隔）判斷的依據。 */
export const notificationLog = okane.table(
  'notification_log',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    eventType: text('event_type').notNull(),
    dedupKey: text('dedup_key').notNull(),
    channel: notificationChannel('channel').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_log_user_dedup_channel_unique').on(t.userId, t.dedupKey, t.channel),
    index('notification_log_user_event_idx').on(t.userId, t.eventType, t.sentAt),
  ],
);

// ---------- AI 輔助（M6）----------

/**
 * BYOK AI 設定（AI-4）：一律走 OpenAI 相容 chat completions 端點——自架（Ollama/LM Studio/vLLM）、
 * Cloudflare Workers AI、OpenRouter 等都相容，一個介面吃全部。key 應用層加密（AGENTS §7）。
 * enabled=false 或未設定時，所有 AI 功能退回純規則版本（AI-1）。
 */
export const aiSettings = okane.table('ai_settings', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  enabled: boolean('enabled').notNull().default(false),
  baseUrl: text('base_url').notNull().default(''),
  model: text('model').notNull().default(''),
  apiKeyEncrypted: text('api_key_encrypted'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Web Push 訂閱（PushSubscription，一裝置一列）。 */
export const webPushSubscriptions = okane.table(
  'web_push_subscriptions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('web_push_subscriptions_user_idx').on(t.userId)],
);
