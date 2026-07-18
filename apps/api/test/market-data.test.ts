import { rm } from 'node:fs/promises';
import { schema, type Db } from '@okane-dokoitta/database';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { fetchAutomaticQuote, MarketDataError } from '../src/market-data.js';
import { createTestDb, TestClient, testEnv } from './helpers.js';

describe('自動報價 provider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('台股使用 TWSE 收盤價，不需要 API token', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify([{ Code: '0050', Date: '20260717', ClosingPrice: '198.50' }]), { status: 200 }));
    const quote = await fetchAutomaticQuote(
      { symbol: '0050', market: 'TW', currency: 'TWD' },
      null,
      fetcher,
    );
    expect(quote).toEqual({ price: '198.50', asOf: new Date('2026-07-16T16:00:00.000Z'), provider: 'twse' });
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('openapi.twse.com.tw'), expect.anything());
  });

  it('VT 使用 Finnhub 且 token 放 header，不放 URL', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ c: 131.25, t: 1784295000 }), { status: 200 }));
    const quote = await fetchAutomaticQuote({ symbol: 'VT', market: 'US', currency: 'USD' }, 'secret-token', fetcher);
    expect(quote.price).toBe('131.25');
    expect(quote.provider).toBe('finnhub');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain('symbol=VT');
    expect(String(url)).not.toContain('secret-token');
    expect((init!.headers as Record<string, string>)['x-finnhub-token']).toBe('secret-token');
  });

  it('美股未設定 token 時回傳可操作的錯誤', async () => {
    await expect(fetchAutomaticQuote({ symbol: 'VT', market: 'US', currency: 'USD' }, null)).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
    } satisfies Partial<MarketDataError>);
  });

  it('provider 沒有行情時間時拒絕保存，不能用抓取時間偽裝新鮮', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ c: 131.25 }), { status: 200 }));
    await expect(fetchAutomaticQuote({ symbol: 'VT', market: 'US', currency: 'USD' }, 'token', fetcher)).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    } satisfies Partial<MarketDataError>);
  });
});

describe('自動報價 API 寫入', () => {
  const env = testEnv();
  let db: Db;
  let client: TestClient;
  const deviceId = uuidv7();
  const securityId = uuidv7();

  beforeAll(async () => {
    await rm(env.dataDir, { recursive: true, force: true });
    env.finnhubToken = 'test-finnhub-token';
    db = await createTestDb();
    const app = createApp(db, env);
    client = new TestClient((request) => app.fetch(request));
    const setup = await client.post('/api/auth/setup', { email: 'quotes@example.com', password: 'quote-password-123' });
    client.csrfToken = ((await setup.json()) as { csrfToken: string }).csrfToken;
    await client.post('/api/sync/devices/register', { id: deviceId, name: 'Quote browser', platform: 'test' });
    await client.post('/api/mutations', mutation(deviceId, 'securities', 'create', securityId, {
      symbol: 'VT', name: 'Vanguard Total World Stock ETF', market: 'US', currency: 'USD', kind: 'etf',
    }));
  }, 120_000);

  afterAll(async () => {
    await rm(env.dataDir, { recursive: true, force: true });
  });

  it('抓取後保存 provider 價格與 audit log', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ c: 132.75, t: 1784295000 }), { status: 200 }));
    const response = await client.post('/api/investments/prices/refresh', { securityId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ price: '132.75', source: 'provider', provider: 'finnhub' });

    const [price] = await db.select().from(schema.marketPrices).where(eq(schema.marketPrices.securityId, securityId));
    expect(price?.source).toBe('provider');
    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, price!.id));
    expect(logs).toHaveLength(1);
  });
});

function mutation(deviceId: string, entity: string, op: string, entityId: string, payload: Record<string, unknown>) {
  return { mutationId: uuidv7(), deviceId, entity, entityId, op, baseVersion: null, payload, clientAt: new Date().toISOString() };
}
