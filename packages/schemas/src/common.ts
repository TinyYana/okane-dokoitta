import { z } from 'zod';

/**
 * API contract 共用基元（AGENTS §4：schemas 是唯一 contract 來源，client/server 共用）。
 * 金額傳輸慣例：JSON 一律用「整數最小單位字串」（"185"、"-350"），禁止 number/浮點。
 */

/** UUIDv7（client 端產生；version nibble = 7） */
export const zUuidV7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'must be UUIDv7');

/** 整數最小單位金額字串 → bigint */
export const zAmountMinor = z
  .string()
  .regex(/^-?\d+$/, 'amount must be an integer string (minor units)')
  .transform((s) => BigInt(s));

/** 正金額（交易金額必須為正；方向由交易類型決定） */
export const zPositiveAmountMinor = zAmountMinor.refine((v) => v > 0n, 'amount must be positive');

/** 民用日期 YYYY-MM-DD（*_date 欄位） */
export const zCivilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

/** UTC 時間點 ISO 8601（*_at 欄位） */
export const zInstant = z.iso.datetime({ offset: true });

export const zCurrency = z.string().length(3).toUpperCase();

/** 正十進位字串（價格/匯率/持股數量；非金額，運算在 domain money module） */
export const zPositiveDecimal = z.string().regex(/^\d+(\.\d+)?$/, 'must be a positive decimal string').refine((v) => Number(v) > 0, 'must be > 0');

/** 樂觀鎖版本 */
export const zVersion = z.number().int().min(1);

export const zErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof zErrorResponse>;
