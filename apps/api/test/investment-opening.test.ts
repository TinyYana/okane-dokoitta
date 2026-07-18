import { rm } from 'node:fs/promises';
import { schema, type Db } from '@okane-dokoitta/database';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestDb, TestClient, testEnv } from './helpers.js';

let db: Db;
let client: TestClient;
const env = testEnv();
const deviceId = uuidv7();

function mutation(entity: string, op: string, entityId: string, payload: Record<string, unknown>) {
  return { mutationId: uuidv7(), deviceId, entity, entityId, op, baseVersion: null, payload, clientAt: new Date().toISOString() };
}

beforeAll(async () => {
  await rm(env.dataDir, { recursive: true, force: true });
  db = await createTestDb();
  client = new TestClient((request) => createApp(db, env).fetch(request));
  const setup = await client.post('/api/auth/setup', { email: 'opening-invest@example.com', password: 'opening-invest-password-123' });
  client.csrfToken = ((await setup.json()) as { csrfToken: string }).csrfToken;
  await client.post('/api/sync/devices/register', { id: deviceId, name: 'Opening investment browser', platform: 'test' });
}, 120_000);

afterAll(async () => {
  await rm(env.dataDir, { recursive: true, force: true });
});

describe('期初持倉', () => {
  it('以期初權益平衡，不扣交割現金，淨資產包含完整持倉', async () => {
    const investmentAccountId = uuidv7();
    expect((await client.post('/api/mutations', mutation('investment_accounts', 'create', investmentAccountId, {
      name: '期初證券', currency: 'TWD',
    }))).status).toBe(200);
    const before = (await (await client.get('/api/investments')).json()) as {
      investmentAccounts: Array<{ id: string; settlementAccountId: string; assetAccountId: string }>;
    };
    const investment = before.investmentAccounts.find((row) => row.id === investmentAccountId)!;
    const securityId = uuidv7();
    expect((await client.post('/api/mutations', mutation('securities', 'create', securityId, {
      symbol: 'OPEN', name: '期初持倉', market: 'TW', currency: 'TWD', kind: 'stock',
    }))).status).toBe(200);
    const [opening] = await db.select().from(schema.accounts).where(eq(schema.accounts.subtype, 'opening_balance'));
    await db.delete(schema.accounts).where(eq(schema.accounts.id, opening!.id));
    const transactionId = uuidv7();
    expect((await client.post('/api/mutations', mutation('transactions', 'create', transactionId, {
      type: 'adjustment', amountMinor: '49000', currency: 'TWD', investmentAccountId,
      securityId, quantity: '1000', occurredAt: '2026-06-30T12:00:00.000Z', source: 'manual',
    }))).status).toBe(200);

    const accounts = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string; balanceMinor: string }> };
    const investments = (await (await client.get('/api/investments')).json()) as { holdings: Array<{ securityId: string; costBasisMinor: string; quantity: string }> };
    expect(accounts.accounts.find((row) => row.id === investment.settlementAccountId)?.balanceMinor).toBe('0');
    expect(accounts.accounts.find((row) => row.id === investment.assetAccountId)?.balanceMinor).toBe('49000');
    expect(investments.holdings.find((row) => row.securityId === securityId)).toMatchObject({ costBasisMinor: '49000', quantity: '1000' });
    const netWorth = (await (await client.get('/api/net-worth')).json()) as { netWorthMinor: string; investmentsMinor: string };
    expect(netWorth.investmentsMinor).toBe('49000');
    expect(netWorth.netWorthMinor).toBe('49000');
    const createdOpenings = await db.select().from(schema.accounts).where(eq(schema.accounts.subtype, 'opening_balance'));
    expect(createdOpenings).toHaveLength(1);
    expect(createdOpenings[0]?.id).not.toBe(opening!.id);

    const lines = await db
      .select({ accountId: schema.journalLines.accountId, amountMinor: schema.journalLines.amountMinor })
      .from(schema.journalLines)
      .innerJoin(schema.journalEntries, eq(schema.journalEntries.id, schema.journalLines.entryId))
      .where(eq(schema.journalEntries.transactionId, transactionId));
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: investment.assetAccountId, amountMinor: 49000n }),
      expect.objectContaining({ amountMinor: -49000n }),
    ]));

    // 使用者誤刪內部平衡帳戶時，下一筆期初持倉會復原原帳戶，不會再建立第二筆。
    const createdOpening = createdOpenings[0]!;
    await db.update(schema.accounts).set({ deletedAt: new Date() }).where(eq(schema.accounts.id, createdOpening.id));
    expect((await client.post('/api/mutations', mutation('transactions', 'create', uuidv7(), {
      type: 'adjustment', amountMinor: '1', currency: 'TWD', investmentAccountId,
      securityId, quantity: '1', occurredAt: '2026-06-30T12:01:00.000Z', source: 'manual',
    }))).status).toBe(200);
    const openingsAfterRestore = await db.select().from(schema.accounts).where(eq(schema.accounts.subtype, 'opening_balance'));
    expect(openingsAfterRestore).toHaveLength(1);
    expect(openingsAfterRestore[0]).toMatchObject({ id: createdOpening.id, deletedAt: null });
  });
});
