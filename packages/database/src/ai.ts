import { eq } from 'drizzle-orm';
import { aiSettings } from './schema.js';
import type { Db } from './index.js';

/** BYOK AI 設定（M6，AI-4）：key 由 API 層加密後才進來，這裡只存取。 */
export interface AiSettingsValue {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKeyEncrypted: string | null;
}

const DEFAULT_AI_SETTINGS: AiSettingsValue = { enabled: false, baseUrl: '', model: '', apiKeyEncrypted: null };

export async function getAiSettings(db: Db, userId: string): Promise<AiSettingsValue> {
  const [row] = await db.select().from(aiSettings).where(eq(aiSettings.userId, userId));
  return row
    ? { enabled: row.enabled, baseUrl: row.baseUrl, model: row.model, apiKeyEncrypted: row.apiKeyEncrypted }
    : DEFAULT_AI_SETTINGS;
}

export async function saveAiSettings(db: Db, userId: string, patch: Partial<AiSettingsValue>): Promise<AiSettingsValue> {
  const merged = { ...(await getAiSettings(db, userId)), ...patch };
  await db
    .insert(aiSettings)
    .values({ userId, ...merged, updatedAt: new Date() })
    .onConflictDoUpdate({ target: aiSettings.userId, set: { ...merged, updatedAt: new Date() } });
  return merged;
}
