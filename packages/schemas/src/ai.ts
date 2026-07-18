import { z } from 'zod';

/** M6 AI 輔助（AI-1~4）：BYOK 設定與各輔助端點的請求格式。 */

export const zAiSettingsUpdate = z
  .object({
    enabled: z.boolean(),
    /** OpenAI 相容 chat completions 端點根路徑，亦接受完整 /chat/completions URL */
    baseUrl: z.string().url().max(500).or(z.literal('')),
    model: z.string().max(200),
    /** undefined＝不動既有 key；null＝清除；字串＝更新 */
    apiKey: z.string().min(1).max(500).nullable(),
  })
  .partial();

export const zAiExtractRequest = z.object({
  /** 帳單/對帳單的髒文字（PDF 貼上、CSV 亂格式都可） */
  text: z.string().min(1).max(20_000),
});

export const zAiNormalizeMerchantRequest = z.object({
  /** 原始商家字串（刷卡單上的縮寫、分店代碼等） */
  merchants: z.array(z.string().min(1).max(200)).min(1).max(50),
});

export const zAiExplainRequest = z.object({
  sessionId: z.string().uuid(),
  candidateId: z.string().uuid(),
});

export const zAiReviewSessionRequest = z.object({
  sessionId: z.string().uuid(),
});

/** AI provider 的不可信輸出；API 驗證後只用來排序與顯示，不寫帳。 */
export const zAiReviewOutput = z.object({
  summary: z.string().trim().min(1).max(1_000),
  candidateOrder: z.array(z.string().uuid()).max(200),
});
