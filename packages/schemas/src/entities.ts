import {
  ACCOUNT_SUBTYPES,
  CARD_STATUSES,
  EXPECTED_STATUSES,
  RATE_SOURCES,
  RECUR_FREQS,
  SECURITY_KINDS,
  TRANSACTION_SOURCES,
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
} from '@okane-dokoitta/domain';
import { z } from 'zod';
import {
  zAmountMinor,
  zCivilDate,
  zCurrency,
  zInstant,
  zPositiveAmountMinor,
  zPositiveDecimal,
  zUuidV7,
  zVersion,
} from './common.js';

// ---------- mutation payloads（寫入走 domain service；lines 不可直接寫入 = I-4）----------

export const zCreditCardFields = z.object({
  issuer: z.string().min(1).max(100),
  cardName: z.string().min(1).max(100),
  last4: z.string().regex(/^\d{4}$/, '只存末四碼').nullish(), // ACCT-7：永不儲存完整卡號；選填，不強迫使用者提供卡號相關資訊
  creditLimitMinor: zPositiveAmountMinor.nullish(),
  limitGroupId: zUuidV7.nullish(),
  statementDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
  autopayDay: z.number().int().min(1).max(31).nullish(),
  autopayAccountId: zUuidV7.nullish(),
  status: z.enum(CARD_STATUSES).default('active'),
});

export const zAccountCreate = z.object({
  subtype: z.enum(ACCOUNT_SUBTYPES),
  name: z.string().min(1).max(100),
  /** 所屬機構（銀行／電支業者，選填）；信用卡發卡行走 creditCard.issuer */
  institution: z.string().min(1).max(100).nullish(),
  currency: zCurrency,
  groupId: zUuidV7.nullish(),
  /** 期初餘額：以 opening_balance equity 對沖的 adjustment 交易（id 由 client 產生） */
  opening: z
    .object({
      transactionId: zUuidV7,
      amountMinor: zPositiveAmountMinor,
      /** 負債帳戶的期初（欠款）設 true */
      isLiability: z.boolean().default(false),
    })
    .nullish(),
  creditCard: zCreditCardFields.nullish(),
});

export const zAccountUpdate = z.object({
  name: z.string().min(1).max(100).optional(),
  institution: z.string().min(1).max(100).nullable().optional(),
  groupId: zUuidV7.nullable().optional(),
  archived: z.boolean().optional(),
  creditCard: zCreditCardFields.partial().optional(),
});

export const zAccountGroupCreate = z.object({
  name: z.string().min(1).max(100),
  sortOrder: z.number().int().default(0),
});
export const zAccountGroupUpdate = zAccountGroupCreate.partial();

// ---------- 投資（M4，INVESTMENT_MODEL）----------

/** 新增投資帳戶（券商）：一次建立交割現金帳戶 + 投資資產帳戶配對（database/mutations.ts createInvestmentAccount） */
export const zInvestmentAccountCreate = z.object({
  name: z.string().min(1).max(100),
  /** 券商（選填）：寫進配對建立的交割／投資資產帳戶的 institution */
  institution: z.string().min(1).max(100).nullish(),
  currency: zCurrency,
});
export const zInvestmentAccountUpdate = z.object({
  name: z.string().min(1).max(100).optional(),
});

export const zSecurityCreate = z.object({
  symbol: z.string().min(1).max(20),
  name: z.string().min(1).max(100),
  market: z.string().min(1).max(20),
  currency: zCurrency,
  kind: z.enum(SECURITY_KINDS).default('stock'),
});
export const zSecurityUpdate = zSecurityCreate.partial();

/** 價格快照：append-only，沒有 update/delete（歷史照常保留） */
export const zMarketPriceCreate = z.object({
  securityId: zUuidV7,
  price: zPositiveDecimal,
  asOf: zInstant,
  source: z.enum(RATE_SOURCES).default('manual'),
});

/** 匯率快照：全域資料（非使用者範疇），append-only */
export const zExchangeRateCreate = z.object({
  base: zCurrency,
  quote: zCurrency,
  rate: zPositiveDecimal,
  asOf: zInstant,
  source: z.enum(RATE_SOURCES).default('manual'),
});

export const zLimitGroupCreate = z.object({
  name: z.string().min(1).max(100),
  issuer: z.string().min(1).max(100),
  limitMinor: zPositiveAmountMinor,
});
export const zLimitGroupUpdate = zLimitGroupCreate.partial();

export const zTransactionCreate = z.object({
  type: z.enum(TRANSACTION_TYPES),
  status: z.enum(TRANSACTION_STATUSES).optional(),
  amountMinor: zPositiveAmountMinor,
  currency: zCurrency,
  fromAccountId: zUuidV7.nullish(),
  toAccountId: zUuidV7.nullish(),
  categoryAccountId: zUuidV7.nullish(),
  originalTransactionId: zUuidV7.nullish(),
  costBasisMinor: zPositiveAmountMinor.nullish(),
  merchantRaw: z.string().max(200).nullish(),
  note: z.string().max(2000).nullish(),
  occurredAt: zInstant,
  authorizedAt: zInstant.nullish(),
  postedAt: zInstant.nullish(),
  dueDate: zCivilDate.nullish(),
  installmentCurrent: z.number().int().min(1).nullish(),
  installmentTotal: z.number().int().min(1).nullish(),
  expectedTransactionId: zUuidV7.nullish(),
  recurringRuleId: zUuidV7.nullish(),
  /** invest_buy/invest_sell/dividend（M4）：指定券商 → server 解析交割/資產帳戶，覆蓋 from/toAccountId */
  investmentAccountId: zUuidV7.nullish(),
  /** invest_buy/invest_sell 用：標的與股數；server 依平均成本法維護 holdings */
  securityId: zUuidV7.nullish(),
  quantity: zPositiveDecimal.nullish(),
  source: z.enum(TRANSACTION_SOURCES).default('manual'),
  /** Discord 草稿（source=discord_draft）用：建立時就標記待使用者在 PWA 確認 */
  needsReview: z.boolean().optional(),
});

/** 更新：可改金額/帳戶/分類（重新產生分錄）、備註、日期；type 不可改 */
export const zTransactionUpdate = z.object({
  status: z.enum(TRANSACTION_STATUSES).optional(),
  needsReview: z.boolean().optional(),
  amountMinor: zPositiveAmountMinor.optional(),
  fromAccountId: zUuidV7.nullish(),
  toAccountId: zUuidV7.nullish(),
  categoryAccountId: zUuidV7.nullish(),
  merchantRaw: z.string().max(200).nullish(),
  note: z.string().max(2000).nullish(),
  occurredAt: zInstant.optional(),
  authorizedAt: zInstant.nullish(),
  postedAt: zInstant.nullish(),
  dueDate: zCivilDate.nullish(),
});

export const zRecurringSchedule = z.object({
  freq: z.enum(RECUR_FREQS),
  interval: z.number().int().min(1).default(1),
  dayOfMonth: z.number().int().min(1).max(31).nullish(),
  month: z.number().int().min(1).max(12).nullish(),
  customEveryDays: z.number().int().min(1).nullish(),
});

export const zRecurringRuleCreate = z.object({
  name: z.string().min(1).max(100),
  schedule: zRecurringSchedule,
  /** null = 浮動金額（RECUR-1）；kind=invest_buy 時必填（圈存的預估額） */
  amountMinor: zPositiveAmountMinor.nullish(),
  currency: zCurrency,
  amountToleranceMinor: zAmountMinor.default(0n),
  dateToleranceDays: z.number().int().min(0).max(31).default(3),
  /** kind=invest_buy 時可省略：server 以 investmentAccountId 解析交割戶帶入 */
  accountId: zUuidV7.optional(),
  categoryAccountId: zUuidV7.nullish(),
  merchantHint: z.string().max(200).nullish(),
  /** 定期定額（Q18）：invest_buy＝到期圈存預估額，確認時填實際成交金額與股數 */
  kind: z.enum(['expense', 'invest_buy']).default('expense'),
  investmentAccountId: zUuidV7.nullish(),
  securityId: zUuidV7.nullish(),
  active: z.boolean().default(true),
  nextExpectedDate: zCivilDate,
});
export const zRecurringRuleUpdate = zRecurringRuleCreate.partial();

/** 預計交易的手動確認/略過（RECUR-5 M1）：status 轉移由 domain 驗證 */
export const zExpectedTransactionUpdate = z.object({
  status: z.enum(EXPECTED_STATUSES),
  matchedTransactionId: zUuidV7.nullish(),
});

// ---------- 讀取資源（server → client；金額一律字串）----------

const amountString = z.string().regex(/^-?\d+$/);

export const zAccountResource = z.object({
  id: zUuidV7,
  kind: z.enum(['asset', 'liability', 'income', 'expense', 'equity']),
  subtype: z.enum(ACCOUNT_SUBTYPES),
  name: z.string(),
  currency: zCurrency,
  groupId: zUuidV7.nullable(),
  archivedAt: zInstant.nullable(),
  balanceMinor: amountString,
  version: zVersion,
  createdAt: zInstant,
  updatedAt: zInstant,
  creditCard: z
    .object({
      issuer: z.string(),
      cardName: z.string(),
      last4: z.string().nullable(),
      creditLimitMinor: amountString.nullable(),
      limitGroupId: zUuidV7.nullable(),
      statementDay: z.number().int(),
      dueDay: z.number().int(),
      autopayDay: z.number().int().nullable(),
      autopayAccountId: zUuidV7.nullable(),
      status: z.enum(CARD_STATUSES),
    })
    .nullable(),
});
export type AccountResource = z.infer<typeof zAccountResource>;

export const zTransactionResource = z.object({
  id: zUuidV7,
  type: z.enum(TRANSACTION_TYPES),
  status: z.enum(TRANSACTION_STATUSES),
  needsReview: z.boolean(),
  amountMinor: amountString,
  currency: zCurrency,
  fromAccountId: zUuidV7.nullable(),
  toAccountId: zUuidV7.nullable(),
  categoryAccountId: zUuidV7.nullable(),
  merchantRaw: z.string().nullable(),
  merchantNormalized: z.string().nullable(),
  note: z.string().nullable(),
  occurredAt: zInstant,
  authorizedAt: zInstant.nullable(),
  postedAt: zInstant.nullable(),
  statementDate: zCivilDate.nullable(),
  dueDate: zCivilDate.nullable(),
  scheduledPaymentAt: zInstant.nullable(),
  settledAt: zInstant.nullable(),
  installmentCurrent: z.number().int().nullable(),
  installmentTotal: z.number().int().nullable(),
  recurringRuleId: zUuidV7.nullable(),
  expectedTransactionId: zUuidV7.nullable(),
  source: z.enum(TRANSACTION_SOURCES),
  version: zVersion,
  createdAt: zInstant,
  updatedAt: zInstant,
  deletedAt: zInstant.nullable(),
});
export type TransactionResource = z.infer<typeof zTransactionResource>;

export const zLimitGroupResource = z.object({
  id: zUuidV7,
  name: z.string(),
  issuer: z.string(),
  limitMinor: amountString,
  version: zVersion,
});
export type LimitGroupResource = z.infer<typeof zLimitGroupResource>;

export const zAccountGroupResource = z.object({
  id: zUuidV7,
  name: z.string(),
  sortOrder: z.number().int(),
  version: zVersion,
});
export type AccountGroupResource = z.infer<typeof zAccountGroupResource>;

export const zRecurringRuleResource = z.object({
  id: zUuidV7,
  name: z.string(),
  schedule: zRecurringSchedule,
  amountMinor: amountString.nullable(),
  currency: zCurrency,
  amountToleranceMinor: amountString,
  dateToleranceDays: z.number().int(),
  accountId: zUuidV7,
  categoryAccountId: zUuidV7.nullable(),
  merchantHint: z.string().nullable(),
  kind: z.enum(['expense', 'invest_buy']),
  investmentAccountId: zUuidV7.nullable(),
  securityId: zUuidV7.nullable(),
  active: z.boolean(),
  nextExpectedDate: zCivilDate,
  version: zVersion,
});
export type RecurringRuleResource = z.infer<typeof zRecurringRuleResource>;

export const zExpectedTransactionResource = z.object({
  id: zUuidV7,
  ruleId: zUuidV7.nullable(),
  expectedDate: zCivilDate,
  amountMinor: amountString.nullable(),
  currency: zCurrency,
  accountId: zUuidV7,
  status: z.enum(EXPECTED_STATUSES),
  matchedTransactionId: zUuidV7.nullable(),
  version: zVersion,
});
export type ExpectedTransactionResource = z.infer<typeof zExpectedTransactionResource>;

/** 信用卡週期視圖（ACCT-5：查詢視圖，非儲存欄位） */
export const zCardCycleView = z.object({
  accountId: zUuidV7,
  currency: zCurrency,
  current: z.object({
    periodStart: zCivilDate,
    periodEnd: zCivilDate,
    statementDate: zCivilDate,
    dueDate: zCivilDate,
    /** 本期已入帳（posted） */
    postedMinor: amountString,
    /** 本期待入帳（pending） */
    pendingMinor: amountString,
    /** 本期退款 */
    refundedMinor: amountString,
  }),
  previous: z.object({
    periodStart: zCivilDate,
    periodEnd: zCivilDate,
    statementDate: zCivilDate,
    dueDate: zCivilDate,
    /** 上期消費總額 */
    totalMinor: amountString,
    /** 上期已繳（結帳後 card_payment 合計） */
    paidMinor: amountString,
    /** 上期待繳 = total − paid（負卡債時 0） */
    unpaidMinor: amountString,
  }),
  /** 卡目前總負債（journal 加總） */
  outstandingMinor: amountString,
  /** 可用額度（卡自身或共用群組扣掉全群組負債；無額度資訊 = null） */
  availableCreditMinor: amountString.nullable(),
});
export type CardCycleView = z.infer<typeof zCardCycleView>;

// ---------- 投資讀取資源（M4）----------

export const zInvestmentAccountResource = z.object({
  id: zUuidV7,
  name: z.string(),
  currency: zCurrency,
  settlementAccountId: zUuidV7,
  assetAccountId: zUuidV7,
  version: zVersion,
});
export type InvestmentAccountResource = z.infer<typeof zInvestmentAccountResource>;

export const zSecurityResource = z.object({
  id: zUuidV7,
  symbol: z.string(),
  name: z.string(),
  market: z.string(),
  currency: zCurrency,
  kind: z.enum(SECURITY_KINDS),
  version: zVersion,
});
export type SecurityResource = z.infer<typeof zSecurityResource>;

export const zHoldingResource = z.object({
  id: zUuidV7,
  assetAccountId: zUuidV7,
  securityId: zUuidV7,
  quantity: z.string(),
  costBasisMinor: amountString,
  latestPrice: z.object({ price: z.string(), asOf: zInstant }).nullable(),
  marketValueMinor: amountString.nullable(),
});
export type HoldingResource = z.infer<typeof zHoldingResource>;

/** 首頁淨資產一覽（INVESTMENT_MODEL §4；INV-5） */
export const zNetWorthSummary = z.object({
  baseCurrency: zCurrency,
  cashMinor: amountString,
  investmentsMinor: amountString,
  liabilitiesMinor: amountString,
  netWorthMinor: amountString,
  /** 換算/估值缺資料時仍顯示金額，但標記不完整（缺匯率或缺報價） */
  incomplete: z.boolean(),
  /** 所有用到的匯率/價格中最舊的 as_of；null = 無需任何換算 */
  oldestDataAsOf: zInstant.nullable(),
  upcomingOutflow30dMinor: amountString,
});
export type NetWorthSummary = z.infer<typeof zNetWorthSummary>;
