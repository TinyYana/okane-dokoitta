import { z } from 'zod';
import { zInstant, zUuidV7, zVersion } from './common.js';
import {
  zAccountCreate,
  zAccountGroupCreate,
  zAccountGroupUpdate,
  zAccountUpdate,
  zExchangeRateCreate,
  zExpectedTransactionUpdate,
  zInvestmentAccountCreate,
  zInvestmentAccountUpdate,
  zLimitGroupCreate,
  zLimitGroupUpdate,
  zMarketPriceCreate,
  zRecurringRuleCreate,
  zRecurringRuleUpdate,
  zSecurityCreate,
  zSecurityUpdate,
  zTransactionCreate,
  zTransactionUpdate,
} from './entities.js';

/**
 * Mutation envelope（SYNC_DESIGN §3.1；M1 起冪等形狀就位，M2 outbox 直接沿用）。
 * 所有帳本寫入都走這個形狀：POST /api/mutations。
 */

export const MUTATION_ENTITIES = [
  'accounts',
  'account_groups',
  'credit_limit_groups',
  'transactions',
  'recurring_rules',
  'expected_transactions',
  'investment_accounts',
  'securities',
  'market_prices',
  'exchange_rates',
] as const;
export type MutationEntity = (typeof MUTATION_ENTITIES)[number];

export const zMutationEnvelope = z.object({
  mutationId: zUuidV7, // 冪等鍵，client 產生
  deviceId: zUuidV7,
  entity: z.enum(MUTATION_ENTITIES),
  entityId: zUuidV7, // create 時也由 client 產生
  op: z.enum(['create', 'update', 'delete']), // delete = 軟刪除
  baseVersion: zVersion.nullable(), // update/delete 必帶
  payload: z.record(z.string(), z.unknown()),
  clientAt: zInstant, // 僅記錄用，不參與衝突判定
});
export type MutationEnvelope = z.infer<typeof zMutationEnvelope>;

/** entity × op → payload schema（server 端二次驗證入口） */
export const MUTATION_PAYLOAD_SCHEMAS = {
  accounts: { create: zAccountCreate, update: zAccountUpdate },
  account_groups: { create: zAccountGroupCreate, update: zAccountGroupUpdate },
  credit_limit_groups: { create: zLimitGroupCreate, update: zLimitGroupUpdate },
  transactions: { create: zTransactionCreate, update: zTransactionUpdate },
  recurring_rules: { create: zRecurringRuleCreate, update: zRecurringRuleUpdate },
  expected_transactions: { create: null, update: zExpectedTransactionUpdate }, // expected 由 server 從 rule 展開，client 不能 create
  investment_accounts: { create: zInvestmentAccountCreate, update: zInvestmentAccountUpdate },
  securities: { create: zSecurityCreate, update: zSecurityUpdate },
  market_prices: { create: zMarketPriceCreate, update: null }, // append-only（INVESTMENT_MODEL §5）
  exchange_rates: { create: zExchangeRateCreate, update: null }, // append-only
} as const;

export const MUTATION_RESULTS = ['applied', 'duplicate', 'rejected_conflict', 'rejected_invalid'] as const;
export type MutationResult = (typeof MUTATION_RESULTS)[number];

export const zMutationResponse = z.object({
  mutationId: zUuidV7,
  result: z.enum(MUTATION_RESULTS),
  /** applied/duplicate：套用後版本 */
  version: zVersion.nullish(),
  /** rejected_*：錯誤碼與訊息 */
  error: z.object({ code: z.string(), message: z.string() }).nullish(),
  /** rejected_conflict：server 現況（衝突 UI 用，M2） */
  serverSnapshot: z.record(z.string(), z.unknown()).nullish(),
});
export type MutationResponse = z.infer<typeof zMutationResponse>;
