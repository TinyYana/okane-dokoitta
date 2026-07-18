import { type Db } from '@okane-dokoitta/database';
import { v7 as uuidv7 } from 'uuid';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestDb, TestClient, testEnv } from './helpers.js';

/**
 * L3：完整備份 round-trip（資料所有權——帶得走也帶得回來）。
 * 舊伺服器建帳記帳 → 匯出 JSON → 全新伺服器新帳號 → 匯入 → 淨資產與資料筆數一致。
 */

type ExportBody = { formatVersion: number; data: Record<string, unknown[]> };

let oldDb: Db;
let newDb: Db;
let oldClient: TestClient;
let newClient: TestClient;
let exported: ExportBody;

const bankId = uuidv7();
const deviceId = uuidv7();

function envelope(entity: string, op: 'create' | 'update' | 'delete', entityId: string, payload: unknown, baseVersion: number | null = null) {
  return { mutationId: uuidv7(), deviceId, entity, entityId, op, baseVersion, payload: payload ?? {}, clientAt: new Date().toISOString() };
}

async function setupUser(db: Db): Promise<TestClient> {
  const app = createApp(db, testEnv());
  const client = new TestClient((req) => app.fetch(req));
  const res = await client.post('/api/auth/setup', { email: 'author@example.com', password: 'correct-horse-battery', displayName: '作者' });
  expect(res.status).toBe(200);
  client.csrfToken = ((await res.json()) as { csrfToken: string }).csrfToken;
  return client;
}

beforeAll(async () => {
  oldDb = await createTestDb();
  newDb = await createTestDb();
  oldClient = await setupUser(oldDb);
  newClient = await setupUser(newDb);
}, 240_000);

describe('完整備份匯入（/api/import/json）', () => {
  it('舊伺服器：記帳後匯出', async () => {
    const create = await oldClient.post(
      '/api/mutations',
      envelope('accounts', 'create', bankId, {
        subtype: 'bank',
        name: '搬家銀行',
        currency: 'TWD',
        opening: { transactionId: uuidv7(), amountMinor: '10000', isLiability: false },
      }),
    );
    expect(create.status).toBe(200);

    const accounts = (await (await oldClient.get('/api/accounts')).json()) as { accounts: Array<{ id: string; name: string }> };
    const food = accounts.accounts.find((a) => a.name === '外食');
    expect(food).toBeTruthy();
    const spend = await oldClient.post(
      '/api/mutations',
      envelope('transactions', 'create', uuidv7(), {
        type: 'expense',
        amountMinor: '111',
        currency: 'TWD',
        fromAccountId: bankId,
        categoryAccountId: food!.id,
        merchantRaw: '搬家測試',
        occurredAt: new Date().toISOString(),
        source: 'manual',
      }),
    );
    expect(spend.status).toBe(200);

    const res = await oldClient.get('/api/export/json');
    expect(res.status).toBe(200);
    exported = (await res.json()) as ExportBody;
    expect(exported.data['transactions']?.length).toBeGreaterThan(0);
  });

  it('新伺服器：匯入還原，淨資產與帳務筆數一致', async () => {
    const res = await newClient.post('/api/import/json', exported);
    expect(res.status).toBe(200);
    const summary = (await res.json()) as { imported: Record<string, number>; skippedTables: string[] };
    expect(summary.imported['transactions']).toBe(exported.data['transactions']?.length);
    expect(summary.imported['journal_lines']).toBe(exported.data['journal_lines']?.length);
    expect(summary.skippedTables).toContain('change_log');

    const [oldNet, newNet] = await Promise.all([
      (await oldClient.get('/api/net-worth')).json() as Promise<{ netWorthMinor: string }>,
      (await newClient.get('/api/net-worth')).json() as Promise<{ netWorthMinor: string }>,
    ]);
    expect(newNet.netWorthMinor).toBe(oldNet.netWorthMinor);
    expect(newNet.netWorthMinor).toBe('9889');

    // 預設分類沒有變成兩套：帳戶總數與舊伺服器一致
    const [oldAccounts, newAccounts] = await Promise.all([
      (await oldClient.get('/api/accounts')).json() as Promise<{ accounts: unknown[] }>,
      (await newClient.get('/api/accounts')).json() as Promise<{ accounts: unknown[] }>,
    ]);
    expect(newAccounts.accounts.length).toBe(oldAccounts.accounts.length);

    // 再匯出一次，帳務表筆數與原始匯出一致（round-trip 完整性）
    const reExported = (await (await newClient.get('/api/export/json')).json()) as ExportBody;
    for (const key of ['accounts', 'transactions', 'journal_entries', 'journal_lines', 'recurring_rules'] as const) {
      expect(reExported.data[key]?.length).toBe(exported.data[key]?.length);
    }
  });

  it('已有帳務資料的帳號再匯入 → 409', async () => {
    const res = await newClient.post('/api/import/json', exported);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('LEDGER_NOT_EMPTY');
  });

  it('不是備份檔的 JSON → 422', async () => {
    const res = await newClient.post('/api/import/json', { whatever: true });
    expect(res.status).toBe(422);
  });
});
