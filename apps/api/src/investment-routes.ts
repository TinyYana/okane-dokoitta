import { listSecurities, recordProviderMarketPrice, toJsonSafe, type Db } from '@okane-dokoitta/database';
import { Hono } from 'hono';
import type { AuthContext } from './auth.js';
import type { ApiEnv } from './env.js';
import { fetchAutomaticQuote, MarketDataError } from './market-data.js';
import { rateLimit } from './security.js';

type Variables = { auth: AuthContext };

export function investmentRoutes(db: Db, env: ApiEnv): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', rateLimit({ windowMs: 60_000, max: 30, keyFn: (c) => `quote:${c.get('auth').userId}` }));

  app.post('/prices/refresh', async (c) => {
    const securityId = ((await c.req.json().catch(() => null)) as { securityId?: unknown } | null)?.securityId;
    if (typeof securityId !== 'string') {
      return c.json({ error: { code: 'INVALID_INPUT', message: '缺少標的識別碼' } }, 422);
    }
    const userId = c.get('auth').userId;
    const security = (await listSecurities(db, userId)).find((item) => item.id === securityId);
    if (!security) return c.json({ error: { code: 'NOT_FOUND', message: '找不到標的' } }, 404);

    try {
      const quote = await fetchAutomaticQuote(security, env.finnhubToken);
      const saved = await recordProviderMarketPrice(db, {
        userId,
        securityId,
        price: quote.price,
        asOf: quote.asOf,
      });
      return c.json(toJsonSafe({ ...saved, provider: quote.provider }) as Record<string, unknown>);
    } catch (error) {
      if (error instanceof MarketDataError) {
        const status = error.code === 'PROVIDER_NOT_CONFIGURED' || error.code === 'MARKET_UNSUPPORTED' ? 409 : 502;
        return c.json({ error: { code: error.code, message: error.message } }, status);
      }
      throw error;
    }
  });

  return app;
}
