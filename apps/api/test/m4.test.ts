import { rm } from 'node:fs/promises';
import { schema, type Db } from '@okane-dokoitta/database';
import { and, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestDb, TestClient, testEnv } from './helpers.js';

let db: Db;
let client: TestClient;
const env = testEnv();
const deviceId = uuidv7();
let incomeCategoryId = '';
let investmentAccountId = '';
let settlementAccountId = '';
let assetAccountId = '';
let securityId = '';

beforeAll(async () => {
  await rm(env.dataDir, { recursive: true, force: true });
  db = await createTestDb();
  const app = createApp(db, env);
  client = new TestClient((request) => app.fetch(request));
  const setup = await client.post('/api/auth/setup', { email: 'invest@example.com', password: 'invest-password-123' });
  client.csrfToken = ((await setup.json()) as { csrfToken: string }).csrfToken;
  await client.post('/api/sync/devices/register', { id: deviceId, name: 'Investment browser', platform: 'test' });
  const accountsResult = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string; subtype: string }> };
  incomeCategoryId = accountsResult.accounts.find((a) => a.subtype === 'category_income')!.id;
}, 120_000);

afterAll(async () => {
  await rm(env.dataDir, { recursive: true, force: true });
});

function mutation(entity: string, op: string, entityId: string, payload: Record<string, unknown>, baseVersion: number | null = null) {
  return { mutationId: uuidv7(), deviceId, entity, entityId, op, baseVersion, payload, clientAt: new Date().toISOString() };
}

describe('M4 投資帳戶、持倉平均成本法、淨資產一覽', () => {
  it('新增投資帳戶：一次建立交割現金帳戶＋投資資產帳戶配對', async () => {
    investmentAccountId = uuidv7();
    const res = await client.post(
      '/api/mutations',
      mutation('investment_accounts', 'create', investmentAccountId, { name: '測試證券', currency: 'TWD' }),
    );
    expect(res.status).toBe(200);
    const investments = (await (await client.get('/api/investments')).json()) as {
      investmentAccounts: Array<{ id: string; name: string; currency: string; settlementAccountId: string; assetAccountId: string }>;
    };
    const inv = investments.investmentAccounts.find((i) => i.id === investmentAccountId)!;
    expect(inv.name).toBe('測試證券');
    expect(inv.currency).toBe('TWD'); // web 的列表/明細/買賣對話框都依賴這個欄位（曾經漏建、渲染直接炸）
    settlementAccountId = inv.settlementAccountId;
    assetAccountId = inv.assetAccountId;
    const accountsResult = (await (await client.get('/api/accounts')).json()) as {
      accounts: Array<{ id: string; subtype: string }>;
    };
    expect(accountsResult.accounts.some((a) => a.id === settlementAccountId && a.subtype === 'brokerage_settlement')).toBe(true);
    expect(accountsResult.accounts.some((a) => a.id === assetAccountId && a.subtype === 'investment_asset')).toBe(true);
  });

  it('新增標的並買入：holdings 依平均成本法累計', async () => {
    securityId = uuidv7();
    expect(
      (await client.post('/api/mutations', mutation('securities', 'create', securityId, {
        symbol: '0050', name: '元大台灣50', market: 'TW', currency: 'TWD', kind: 'etf',
      }))).status,
    ).toBe(200);

    const buy1 = await client.post('/api/mutations', mutation('transactions', 'create', uuidv7(), {
      type: 'invest_buy', amountMinor: '5000', currency: 'TWD',
      investmentAccountId, securityId, quantity: '100',
      occurredAt: '2026-07-01T02:00:00.000Z', source: 'manual',
    }));
    expect(buy1.status).toBe(200);

    const buy2 = await client.post('/api/mutations', mutation('transactions', 'create', uuidv7(), {
      type: 'invest_buy', amountMinor: '3000', currency: 'TWD',
      investmentAccountId, securityId, quantity: '50',
      occurredAt: '2026-07-05T02:00:00.000Z', source: 'manual',
    }));
    expect(buy2.status).toBe(200);

    const investments = (await (await client.get('/api/investments')).json()) as {
      holdings: Array<{ securityId: string; quantity: string; costBasisMinor: string; marketValueMinor: string | null }>;
    };
    const holding = investments.holdings.find((h) => h.securityId === securityId)!;
    expect(holding.quantity).toBe('150');
    expect(holding.costBasisMinor).toBe('8000');
    expect(holding.marketValueMinor).toBeNull(); // 尚無報價
  });

  it('既有標的可更新名稱，但持倉幣別不能被直接改壞', async () => {
    const current = ((await (await client.get('/api/investments')).json()) as {
      securities: Array<{ id: string; version: number }>;
    }).securities.find((security) => security.id === securityId)!;
    const renamed = await client.post('/api/mutations', mutation('securities', 'update', securityId, {
      name: '元大台灣 50 ETF',
    }, current.version));
    expect(renamed.status).toBe(200);

    const currencyChange = await client.post('/api/mutations', mutation('securities', 'update', securityId, {
      currency: 'USD',
    }, current.version + 1));
    expect(currencyChange.status).toBe(422);
    expect(await currencyChange.json()).toMatchObject({ error: { code: 'SECURITY_CURRENCY_MISMATCH' } });
  });

  it('登記報價後 holdings 顯示市值', async () => {
    const res = await client.post('/api/mutations', mutation('market_prices', 'create', uuidv7(), {
      securityId, price: '60', asOf: '2026-07-10T00:00:00.000Z', source: 'manual',
    }));
    expect(res.status).toBe(200);
    const investments = (await (await client.get('/api/investments')).json()) as {
      holdings: Array<{ securityId: string; marketValueMinor: string | null; latestPrice: { price: string } | null }>;
    };
    const holding = investments.holdings.find((h) => h.securityId === securityId)!;
    expect(holding.latestPrice?.price).toBe('60');
    expect(holding.marketValueMinor).toBe('9000'); // 150 股 × 60（TWD 無小數）
  });

  it('賣出：依比例攤提成本，差額計入損益分類；賣超過持倉拒絕', async () => {
    const oversell = await client.post('/api/mutations', mutation('transactions', 'create', uuidv7(), {
      type: 'invest_sell', amountMinor: '9000', currency: 'TWD',
      investmentAccountId, securityId, quantity: '200', categoryAccountId: incomeCategoryId,
      occurredAt: '2026-07-15T02:00:00.000Z', source: 'manual',
    }));
    expect(oversell.status).toBe(422);
    expect(await oversell.json()).toMatchObject({ error: { code: 'HOLDING_INSUFFICIENT' } });

    const sellId = uuidv7();
    const sell = await client.post('/api/mutations', mutation('transactions', 'create', sellId, {
      type: 'invest_sell', amountMinor: '3500', currency: 'TWD',
      investmentAccountId, securityId, quantity: '50', categoryAccountId: incomeCategoryId,
      occurredAt: '2026-07-15T02:00:00.000Z', source: 'manual',
    }));
    expect(sell.status).toBe(200);

    // 賣 50/150，攤提成本 = round(8000 × 50 / 150) = 2667；剩餘 100 股、成本 5333
    const investments = (await (await client.get('/api/investments')).json()) as {
      holdings: Array<{ securityId: string; quantity: string; costBasisMinor: string }>;
    };
    const holding = investments.holdings.find((h) => h.securityId === securityId)!;
    expect(holding.quantity).toBe('100');
    expect(holding.costBasisMinor).toBe('5333');

    const [txn] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, sellId));
    expect(txn?.quantityMicro?.toString()).toBe('50000000');
  });

  it('股息記入交割帳戶，不影響持倉', async () => {
    const before = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string; balanceMinor: string }> };
    const settlementBefore = BigInt(before.accounts.find((a) => a.id === settlementAccountId)!.balanceMinor);

    const res = await client.post('/api/mutations', mutation('transactions', 'create', uuidv7(), {
      type: 'dividend', amountMinor: '120', currency: 'TWD',
      investmentAccountId, categoryAccountId: incomeCategoryId,
      occurredAt: '2026-07-20T02:00:00.000Z', source: 'manual',
    }));
    expect(res.status).toBe(200);

    const after = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string; balanceMinor: string }> };
    const settlementAfter = BigInt(after.accounts.find((a) => a.id === settlementAccountId)!.balanceMinor);
    expect(settlementAfter - settlementBefore).toBe(120n);
  });

  it('刪除仍被投資帳戶引用的底層帳戶 → 拒絕', async () => {
    const accounts = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string; version: number }> };
    const settlement = accounts.accounts.find((a) => a.id === settlementAccountId)!;
    const res = await client.post('/api/mutations', mutation('accounts', 'delete', settlementAccountId, {}, settlement.version));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: 'ACCOUNT_IN_USE' } });
  });

  it('刪除仍有持倉的標的 → 拒絕；淨資產一覽反映市值與資料新鮮度', async () => {
    const investments = (await (await client.get('/api/investments')).json()) as {
      securities: Array<{ id: string; version: number }>;
    };
    const security = investments.securities.find((s) => s.id === securityId)!;
    const del = await client.post('/api/mutations', mutation('securities', 'delete', securityId, {}, security.version));
    expect(del.status).toBe(422);
    expect(await del.json()).toMatchObject({ error: { code: 'SECURITY_IN_USE' } });

    const netWorth = (await (await client.get('/api/net-worth')).json()) as {
      baseCurrency: string;
      investmentsMinor: string;
      incomplete: boolean;
      oldestDataAsOf: string | null;
    };
    expect(netWorth.baseCurrency).toBe('TWD');
    expect(netWorth.investmentsMinor).toBe('6000'); // 100 股 × 60（同幣別不需匯率，incomplete 仍可能因其他原因為 true，只檢查市值）
    expect(netWorth.incomplete).toBe(false);
    expect(netWorth.oldestDataAsOf).toBe('2026-07-10T00:00:00.000Z');
  });

  it('外幣持倉缺匯率時淨資產標記不完整；補上匯率後換算生效', async () => {
    await client.post('/api/me/base-currency', { currency: 'TWD' });
    const usdInvestmentId = uuidv7();
    await client.post('/api/mutations', mutation('investment_accounts', 'create', usdInvestmentId, { name: '美股帳戶', currency: 'USD' }));
    const usdSecurityId = uuidv7();
    await client.post('/api/mutations', mutation('securities', 'create', usdSecurityId, {
      symbol: 'VOO', name: 'Vanguard S&P 500', market: 'US', currency: 'USD', kind: 'etf',
    }));
    await client.post('/api/mutations', mutation('transactions', 'create', uuidv7(), {
      type: 'invest_buy', amountMinor: '10000', currency: 'USD',
      investmentAccountId: usdInvestmentId, securityId: usdSecurityId, quantity: '2',
      occurredAt: '2026-07-21T02:00:00.000Z', source: 'manual',
    }));

    const incompleteNetWorth = (await (await client.get('/api/net-worth')).json()) as { incomplete: boolean };
    expect(incompleteNetWorth.incomplete).toBe(true); // USD 交割現金無匯率可換算

    const rateRes = await client.post('/api/mutations', mutation('exchange_rates', 'create', uuidv7(), {
      base: 'USD', quote: 'TWD', rate: '32', asOf: '2026-07-22T00:00:00.000Z', source: 'manual',
    }));
    expect(rateRes.status).toBe(200);
    await client.post('/api/mutations', mutation('market_prices', 'create', uuidv7(), {
      securityId: usdSecurityId, price: '55', asOf: '2026-07-22T00:00:00.000Z', source: 'manual',
    }));

    const completeNetWorth = (await (await client.get('/api/net-worth')).json()) as { incomplete: boolean; cashMinor: string };
    expect(completeNetWorth.incomplete).toBe(false);
  });
});

describe('M4 迴歸：holdings 在刪除/編輯 invest_buy/invest_sell 後必須重放，不能留下幽靈股數', () => {
  let invId = '';
  let settleId = '';
  let assetId = '';
  let secId = '';

  async function settlementBalance(): Promise<bigint> {
    const accounts = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string; balanceMinor: string }> };
    return BigInt(accounts.accounts.find((a) => a.id === settleId)!.balanceMinor);
  }

  async function holding(): Promise<{ quantity: string; costBasisMinor: string } | undefined> {
    const investments = (await (await client.get('/api/investments')).json()) as {
      holdings: Array<{ securityId: string; quantity: string; costBasisMinor: string }>;
    };
    return investments.holdings.find((h) => h.securityId === secId);
  }

  async function version(entityId: string): Promise<number> {
    const txns = (await (await client.get('/api/transactions?limit=200')).json()) as { transactions: Array<{ id: string; version: number }> };
    return txns.transactions.find((t) => t.id === entityId)!.version;
  }

  beforeAll(async () => {
    invId = uuidv7();
    await client.post('/api/mutations', mutation('investment_accounts', 'create', invId, { name: '迴歸測試證券', currency: 'TWD' }));
    const investments = (await (await client.get('/api/investments')).json()) as {
      investmentAccounts: Array<{ id: string; settlementAccountId: string; assetAccountId: string }>;
    };
    const inv = investments.investmentAccounts.find((i) => i.id === invId)!;
    settleId = inv.settlementAccountId;
    assetId = inv.assetAccountId;
    secId = uuidv7();
    await client.post('/api/mutations', mutation('securities', 'create', secId, {
      symbol: 'REG', name: '迴歸測試標的', market: 'TW', currency: 'TWD', kind: 'stock',
    }));
  });

  it('刪除賣出交易：holdings 與交割現金都要回復到賣出前，不能留在「已賣出」狀態', async () => {
    await client.post('/api/mutations', mutation('transactions', 'create', uuidv7(), {
      type: 'invest_buy', amountMinor: '10000', currency: 'TWD',
      investmentAccountId: invId, securityId: secId, quantity: '100',
      occurredAt: '2026-06-01T02:00:00.000Z', source: 'manual',
    }));
    const settleBeforeSell = await settlementBalance();

    const sellId = uuidv7();
    await client.post('/api/mutations', mutation('transactions', 'create', sellId, {
      type: 'invest_sell', amountMinor: '5000', currency: 'TWD',
      investmentAccountId: invId, securityId: secId, quantity: '40', categoryAccountId: incomeCategoryId,
      occurredAt: '2026-06-02T02:00:00.000Z', source: 'manual',
    }));
    expect((await holding())?.quantity).toBe('60');
    expect((await holding())?.costBasisMinor).toBe('6000');
    expect(await settlementBalance()).toBe(settleBeforeSell + 5000n);

    const del = await client.post('/api/mutations', mutation('transactions', 'delete', sellId, {}, await version(sellId)));
    expect(del.status).toBe(200);

    // 刪除賣出後：40 股與其成本要還原回持倉，交割現金要吐回賣出的 5000
    expect((await holding())?.quantity).toBe('100');
    expect((await holding())?.costBasisMinor).toBe('10000');
    expect(await settlementBalance()).toBe(settleBeforeSell);

    // 拿「還原後」的持倉重賣一次：交割現金只能照這次實際賣出的金額增加，不能疊加刪除前那筆
    const settleBeforeResell = await settlementBalance();
    const resell = await client.post('/api/mutations', mutation('transactions', 'create', uuidv7(), {
      type: 'invest_sell', amountMinor: '12000', currency: 'TWD',
      investmentAccountId: invId, securityId: secId, quantity: '100', categoryAccountId: incomeCategoryId,
      occurredAt: '2026-06-03T02:00:00.000Z', source: 'manual',
    }));
    expect(resell.status).toBe(200);
    expect(await settlementBalance()).toBe(settleBeforeResell + 12000n);
    expect((await holding())?.quantity).toBe('0');
  });

  it('刪除已被後續賣出用掉的買入 → 拒絕（不能無中生有留下幽靈股數）', async () => {
    const buyId = uuidv7();
    await client.post('/api/mutations', mutation('transactions', 'create', buyId, {
      type: 'invest_buy', amountMinor: '6000', currency: 'TWD',
      investmentAccountId: invId, securityId: secId, quantity: '50',
      occurredAt: '2026-06-10T02:00:00.000Z', source: 'manual',
    }));
    await client.post('/api/mutations', mutation('transactions', 'create', uuidv7(), {
      type: 'invest_sell', amountMinor: '7000', currency: 'TWD',
      investmentAccountId: invId, securityId: secId, quantity: '50', categoryAccountId: incomeCategoryId,
      occurredAt: '2026-06-11T02:00:00.000Z', source: 'manual',
    }));
    expect((await holding())?.quantity).toBe('0');

    const settleBefore = await settlementBalance();
    const del = await client.post('/api/mutations', mutation('transactions', 'delete', buyId, {}, await version(buyId)));
    expect(del.status).toBe(422);
    expect(await del.json()).toMatchObject({ error: { code: 'HOLDING_INSUFFICIENT' } });
    // 拒絕的刪除不能留下部分寫入：交割現金與持倉都要維持原樣
    expect(await settlementBalance()).toBe(settleBefore);
    expect((await holding())?.quantity).toBe('0');
  });

  it('編輯賣出金額：成本基礎與已實現損益要保留，不能被新金額覆蓋成 0', async () => {
    await client.post('/api/mutations', mutation('transactions', 'create', uuidv7(), {
      type: 'invest_buy', amountMinor: '3000', currency: 'TWD',
      investmentAccountId: invId, securityId: secId, quantity: '30',
      occurredAt: '2026-06-20T02:00:00.000Z', source: 'manual',
    }));
    const sellId = uuidv7();
    await client.post('/api/mutations', mutation('transactions', 'create', sellId, {
      type: 'invest_sell', amountMinor: '4000', currency: 'TWD',
      investmentAccountId: invId, securityId: secId, quantity: '30', categoryAccountId: incomeCategoryId,
      occurredAt: '2026-06-21T02:00:00.000Z', source: 'manual',
    }));
    const settleBeforeEdit = await settlementBalance();

    // 訂正成交金額 4000 → 4500（賣出股數不變，成本基礎理應照舊是 3000）
    const edit = await client.post('/api/mutations', mutation('transactions', 'update', sellId, { amountMinor: '4500' }, await version(sellId)));
    expect(edit.status).toBe(200);
    expect(await settlementBalance()).toBe(settleBeforeEdit + 500n);

    const [entry] = await db
      .select({ id: schema.journalEntries.id })
      .from(schema.journalEntries)
      .where(and(eq(schema.journalEntries.transactionId, sellId), isNull(schema.journalEntries.deletedAt)));
    const lines = await db.select().from(schema.journalLines).where(eq(schema.journalLines.entryId, entry!.id));
    const assetLine = lines.find((l) => l.accountId === assetId);
    // 成本基礎沒被新金額覆蓋：投資資產帳戶這筆線仍是 -3000（原成本），不是 -4500
    expect(assetLine?.amountMinor.toString()).toBe('-3000');
  });
});
