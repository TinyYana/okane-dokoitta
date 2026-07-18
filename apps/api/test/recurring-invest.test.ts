import { rm } from 'node:fs/promises';
import { type Db } from '@okane-dokoitta/database';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestDb, TestClient, testEnv } from './helpers.js';

let db: Db;
let client: TestClient;
const env = testEnv();
const deviceId = uuidv7();
let investmentAccountId = '';
let settlementAccountId = '';
let securityId = '';
let ruleId = '';

function localDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

beforeAll(async () => {
  await rm(env.dataDir, { recursive: true, force: true });
  db = await createTestDb();
  const app = createApp(db, env);
  client = new TestClient((request) => app.fetch(request));
  const setup = await client.post('/api/auth/setup', { email: 'dca@example.com', password: 'dca-password-123456' });
  client.csrfToken = ((await setup.json()) as { csrfToken: string }).csrfToken;
  await client.post('/api/sync/devices/register', { id: deviceId, name: 'DCA browser', platform: 'test' });

  investmentAccountId = uuidv7();
  await client.post('/api/mutations', mutation('investment_accounts', 'create', investmentAccountId, { name: '定期定額證券', currency: 'TWD' }));
  const investments = (await (await client.get('/api/investments')).json()) as {
    investmentAccounts: Array<{ id: string; settlementAccountId: string }>;
  };
  settlementAccountId = investments.investmentAccounts.find((i) => i.id === investmentAccountId)!.settlementAccountId;
  securityId = uuidv7();
  await client.post('/api/mutations', mutation('securities', 'create', securityId, {
    symbol: '0050', name: '元大台灣50', market: 'TW', currency: 'TWD', kind: 'etf',
  }));
}, 120_000);

afterAll(async () => {
  await rm(env.dataDir, { recursive: true, force: true });
});

function mutation(entity: string, op: string, entityId: string, payload: Record<string, unknown>, baseVersion: number | null = null) {
  return { mutationId: uuidv7(), deviceId, entity, entityId, op, baseVersion, payload, clientAt: new Date().toISOString() };
}

describe('Q18 定期定額（圈存式 recurring invest_buy）', () => {
  it('缺標的或缺預估金額拒絕', async () => {
    const noSecurity = await client.post('/api/mutations', mutation('recurring_rules', 'create', uuidv7(), {
      name: '壞規則', schedule: { freq: 'monthly', interval: 1, dayOfMonth: 1 },
      amountMinor: '3000', currency: 'TWD', amountToleranceMinor: '0', dateToleranceDays: 3,
      kind: 'invest_buy', investmentAccountId, active: true, nextExpectedDate: localDate(1),
    }));
    expect(noSecurity.status).toBe(422);
    const noAmount = await client.post('/api/mutations', mutation('recurring_rules', 'create', uuidv7(), {
      name: '壞規則2', schedule: { freq: 'monthly', interval: 1, dayOfMonth: 1 },
      amountMinor: null, currency: 'TWD', amountToleranceMinor: '0', dateToleranceDays: 3,
      kind: 'invest_buy', investmentAccountId, securityId, active: true, nextExpectedDate: localDate(1),
    }));
    expect(noAmount.status).toBe(422);
  });

  it('建立定期定額規則：扣款帳戶＝交割戶、expected 圈存預估額、反映在 30 天預計流出', async () => {
    ruleId = uuidv7();
    const res = await client.post('/api/mutations', mutation('recurring_rules', 'create', ruleId, {
      name: '每月買 0050', schedule: { freq: 'monthly', interval: 1, dayOfMonth: 1 },
      amountMinor: '3000', currency: 'TWD', amountToleranceMinor: '0', dateToleranceDays: 3,
      kind: 'invest_buy', investmentAccountId, securityId, active: true, nextExpectedDate: localDate(1),
    }));
    expect(res.status).toBe(200);

    const recurring = (await (await client.get('/api/recurring')).json()) as {
      rules: Array<{ id: string; kind: string; accountId: string; investmentAccountId: string | null; securityId: string | null }>;
      expected: Array<{ ruleId: string | null; amountMinor: string | null; accountId: string; status: string }>;
    };
    const rule = recurring.rules.find((r) => r.id === ruleId)!;
    expect(rule.kind).toBe('invest_buy');
    expect(rule.accountId).toBe(settlementAccountId);
    expect(rule.investmentAccountId).toBe(investmentAccountId);
    expect(rule.securityId).toBe(securityId);
    const hold = recurring.expected.find((e) => e.ruleId === ruleId)!;
    expect(hold.amountMinor).toBe('3000');
    expect(hold.accountId).toBe(settlementAccountId);
    expect(hold.status).toBe('scheduled');

    // 圈存語意：未確認前就佔住 30 天預計流出
    const netWorth = (await (await client.get('/api/net-worth')).json()) as { upcomingOutflow30dMinor: string };
    expect(netWorth.upcomingOutflow30dMinor).toBe('3000');
  });

  it('確認：填實際成交金額與股數 → 入帳、持倉更新、規則推進下一期', async () => {
    const recurring = (await (await client.get('/api/recurring')).json()) as {
      rules: Array<{ id: string; nextExpectedDate: string }>;
      expected: Array<{ id: string; ruleId: string | null; version: number }>;
    };
    const hold = recurring.expected.find((e) => e.ruleId === ruleId)!;

    const txnId = uuidv7();
    const buy = await client.post('/api/mutations', mutation('transactions', 'create', txnId, {
      type: 'invest_buy', amountMinor: '2985', currency: 'TWD',
      investmentAccountId, securityId, quantity: '4.2',
      occurredAt: new Date().toISOString(), expectedTransactionId: hold.id, recurringRuleId: ruleId, source: 'recurring',
    }));
    expect(buy.status).toBe(200);
    const confirm = await client.post('/api/mutations', mutation('expected_transactions', 'update', hold.id, {
      status: 'confirmed', matchedTransactionId: txnId,
    }, hold.version));
    expect(confirm.status).toBe(200);

    const investments = (await (await client.get('/api/investments')).json()) as {
      holdings: Array<{ securityId: string; quantity: string; costBasisMinor: string }>;
    };
    const holding = investments.holdings.find((h) => h.securityId === securityId)!;
    expect(holding.quantity).toBe('4.2');
    expect(holding.costBasisMinor).toBe('2985');

    const after = (await (await client.get('/api/recurring')).json()) as {
      rules: Array<{ id: string; nextExpectedDate: string }>;
      expected: Array<{ ruleId: string | null; status: string }>;
    };
    const rule = after.rules.find((r) => r.id === ruleId)!;
    expect(rule.nextExpectedDate > localDate(1)).toBe(true); // 推進到下一期
    expect(after.expected.some((e) => e.ruleId === ruleId && e.status === 'scheduled')).toBe(true); // 下一期圈存已就位
  });
});
