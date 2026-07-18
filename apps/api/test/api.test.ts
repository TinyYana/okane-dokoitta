import { createUserWithDefaults, applyMutation, schema, type Db } from '@okane-dokoitta/database';
import { and, eq, isNotNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestDb, TestClient, testEnv } from './helpers.js';

/**
 * L3 API 整合測試（TESTING §L3）：
 * auth 流程、mutation 冪等與衝突、audit log 全寫入路徑、軟刪除、user_id 隔離、匯出完整性。
 */

let db: Db;
let client: TestClient;

const now = () => new Date().toISOString();
const testDeviceId = uuidv7();

function envelope(entity: string, op: 'create' | 'update' | 'delete', entityId: string, payload: unknown, baseVersion: number | null = null) {
  return {
    mutationId: uuidv7(),
    deviceId: testDeviceId,
    entity,
    entityId,
    op,
    baseVersion,
    payload: payload ?? {},
    clientAt: now(),
  };
}

const bankId = uuidv7();
const openingTxnId = uuidv7();
const cardId = uuidv7();
const limitGroupId = uuidv7();
let foodCategoryId = '';
let accountVersion = 1;

beforeAll(async () => {
  db = await createTestDb();
  const app = createApp(db, testEnv());
  client = new TestClient((req) => app.fetch(req));
}, 120_000);

describe('auth 流程（Q6：單使用者密碼 + session cookie）', () => {
  it('初始狀態 needsSetup', async () => {
    const res = await client.get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ needsSetup: true, authenticated: false });
  });

  it('未登入打 API → 401', async () => {
    const res = await client.get('/api/accounts');
    expect(res.status).toBe(401);
  });

  it('first-run setup 建立使用者並登入', async () => {
    const res = await client.post('/api/auth/setup', {
      email: 'author@example.com',
      password: 'correct-horse-battery',
      displayName: '作者',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { csrfToken: string };
    expect(body.csrfToken).toBeTruthy();
    client.csrfToken = body.csrfToken;
  });

  it('setup 只能執行一次', async () => {
    const res = await client.post('/api/auth/setup', { email: 'x@example.com', password: 'aaaaaaaaaaaa' });
    expect(res.status).toBe(409);
  });

  it('登入後 /api/me 回使用者與 csrf', async () => {
    const res = await client.get('/api/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: 'author@example.com', ledgerTimeZone: 'Asia/Taipei' });
  });

  it('錯誤密碼 → 401', async () => {
    const fresh = new TestClient((req) => createApp(db, testEnv()).fetch(req));
    const res = await fresh.post('/api/auth/login', { email: 'author@example.com', password: 'wrong-password!' });
    expect(res.status).toBe(401);
  });

  it('缺 CSRF header 的寫入 → 403', async () => {
    const saved = client.csrfToken;
    client.csrfToken = '';
    const res = await client.post('/api/mutations', envelope('accounts', 'create', uuidv7(), { subtype: 'cash', name: 'x', currency: 'TWD' }));
    expect(res.status).toBe(403);
    client.csrfToken = saved;
  });
});

describe('帳戶與期初餘額', () => {
  it('setup 已建立預設分類與期初 equity', async () => {
    const res = await client.get('/api/accounts');
    const body = (await res.json()) as { accounts: Array<{ subtype: string; name: string; id: string }> };
    expect(body.accounts.some((a) => a.subtype === 'opening_balance')).toBe(true);
    const food = body.accounts.find((a) => a.name === '外食');
    expect(food).toBeTruthy();
    foodCategoryId = food!.id;
  });

  it('建立銀行帳戶（期初 5000）→ 餘額 = journal 加總 5000', async () => {
    const res = await client.post(
      '/api/mutations',
      envelope('accounts', 'create', bankId, {
        subtype: 'bank',
        name: '測試銀行',
        currency: 'TWD',
        opening: { transactionId: openingTxnId, amountMinor: '5000', isLiability: false },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: 'applied', version: 1 });

    const accounts = (await (await client.get('/api/accounts')).json()) as {
      accounts: Array<{ id: string; balanceMinor: string }>;
    };
    expect(accounts.accounts.find((a) => a.id === bankId)?.balanceMinor).toBe('5000');
  });

  it('冪等：同 mutationId 重送 → duplicate，不重複套用', async () => {
    const m = envelope('accounts', 'create', uuidv7(), { subtype: 'cash', name: '現金', currency: 'TWD' });
    const first = await client.post('/api/mutations', m);
    expect((await first.json()) as object).toMatchObject({ result: 'applied' });
    const second = await client.post('/api/mutations', m);
    expect(((await second.json()) as { result: string }).result).toBe('duplicate');
    const accounts = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ name: string }> };
    expect(accounts.accounts.filter((a) => a.name === '現金')).toHaveLength(1);
  });

  it('樂觀版本衝突：錯的 baseVersion → 409 rejected_conflict，不套用', async () => {
    const res = await client.post('/api/mutations', envelope('accounts', 'update', bankId, { name: '不該成功' }, 99));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { result: string }).result).toBe('rejected_conflict');
    const accounts = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string; name: string }> };
    expect(accounts.accounts.find((a) => a.id === bankId)?.name).toBe('測試銀行');
  });

  it('正確 baseVersion 的更新 → applied', async () => {
    const res = await client.post('/api/mutations', envelope('accounts', 'update', bankId, { name: '薪轉銀行' }, 1));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number };
    accountVersion = body.version;
    expect(accountVersion).toBe(2);
  });
});

describe('交易與複式帳本', () => {
  const expenseId = uuidv7();

  it('記一筆支出 185 → 餘額 4815；分錄平衡', async () => {
    const res = await client.post(
      '/api/mutations',
      envelope('transactions', 'create', expenseId, {
        type: 'expense',
        amountMinor: '185',
        currency: 'TWD',
        fromAccountId: bankId,
        categoryAccountId: foodCategoryId,
        merchantRaw: '便利商店',
        occurredAt: now(),
        source: 'manual',
      }),
    );
    expect(res.status).toBe(200);
    const accounts = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string; balanceMinor: string }> };
    expect(accounts.accounts.find((a) => a.id === bankId)?.balanceMinor).toBe('4815');

    const txns = (await (await client.get('/api/transactions')).json()) as { transactions: Array<{ id: string; status: string }> };
    expect(txns.transactions.some((t) => t.id === expenseId)).toBe(true);
    // 非信用卡來源 → 預設 posted
    expect(txns.transactions.find((t) => t.id === expenseId)?.status).toBe('posted');
  });

  it('無效交易被 domain 拒絕（分類 kind 不符）→ 422，不留殘骸', async () => {
    const res = await client.post(
      '/api/mutations',
      envelope('transactions', 'create', uuidv7(), {
        type: 'expense',
        amountMinor: '100',
        currency: 'TWD',
        fromAccountId: bankId,
        categoryAccountId: bankId, // 銀行帳戶不是分類
        occurredAt: now(),
        source: 'manual',
      }),
    );
    expect(res.status).toBe(422);
    const accounts = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string; balanceMinor: string }> };
    expect(accounts.accounts.find((a) => a.id === bankId)?.balanceMinor).toBe('4815'); // 餘額不變
  });

  it('退款必須連結原交易；退款後餘額回復', async () => {
    const noLink = await client.post(
      '/api/mutations',
      envelope('transactions', 'create', uuidv7(), {
        type: 'refund',
        amountMinor: '185',
        currency: 'TWD',
        toAccountId: bankId,
        categoryAccountId: foodCategoryId,
        occurredAt: now(),
        source: 'manual',
      }),
    );
    expect(noLink.status).toBe(422); // REFUND_MISSING_LINK

    const refundId = uuidv7();
    const linked = await client.post(
      '/api/mutations',
      envelope('transactions', 'create', refundId, {
        type: 'refund',
        amountMinor: '185',
        currency: 'TWD',
        toAccountId: bankId,
        categoryAccountId: foodCategoryId,
        originalTransactionId: expenseId,
        occurredAt: now(),
        source: 'manual',
      }),
    );
    expect(linked.status).toBe(200);
    const accounts = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string; balanceMinor: string }> };
    expect(accounts.accounts.find((a) => a.id === bankId)?.balanceMinor).toBe('5000');
    // link 已建立
    const links = await db.select().from(schema.transactionLinks).where(eq(schema.transactionLinks.toTransactionId, refundId));
    expect(links).toHaveLength(1);
    expect(links[0]!.kind).toBe('refund');
    expect(links[0]!.fromTransactionId).toBe(expenseId);
  });

  it('軟刪除交易：餘額回復、清單消失、資料仍在 DB（deleted_at）', async () => {
    const tempId = uuidv7();
    await client.post(
      '/api/mutations',
      envelope('transactions', 'create', tempId, {
        type: 'expense',
        amountMinor: '1000',
        currency: 'TWD',
        fromAccountId: bankId,
        categoryAccountId: foodCategoryId,
        occurredAt: now(),
        source: 'manual',
      }),
    );
    const del = await client.post('/api/mutations', envelope('transactions', 'delete', tempId, {}, 1));
    expect(del.status).toBe(200);

    const accounts = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string; balanceMinor: string }> };
    expect(accounts.accounts.find((a) => a.id === bankId)?.balanceMinor).toBe('5000');
    const txns = (await (await client.get('/api/transactions')).json()) as { transactions: Array<{ id: string }> };
    expect(txns.transactions.some((t) => t.id === tempId)).toBe(false);
    // 軟刪除：row 仍在
    const [row] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, tempId));
    expect(row?.deletedAt).toBeTruthy();
    const entries = await db
      .select()
      .from(schema.journalEntries)
      .where(and(eq(schema.journalEntries.transactionId, tempId), isNotNull(schema.journalEntries.deletedAt)));
    expect(entries.length).toBeGreaterThan(0);
  });
});

describe('信用卡：共用額度群組、週期視圖、繳款（F3/F6）', () => {
  it('建立額度群組與信用卡', async () => {
    const g = await client.post(
      '/api/mutations',
      envelope('credit_limit_groups', 'create', limitGroupId, { name: '國泰共用', issuer: '國泰', limitMinor: '100000' }),
    );
    expect(g.status).toBe(200);
    const cardRes = await client.post(
      '/api/mutations',
      envelope('accounts', 'create', cardId, {
        subtype: 'credit_card',
        name: '測試卡',
        currency: 'TWD',
        creditCard: {
          issuer: '國泰',
          cardName: 'CUBE',
          last4: '1234',
          limitGroupId,
          statementDay: 15,
          dueDay: 3,
          status: 'active',
        },
      }),
    );
    expect(cardRes.status).toBe(200);
  });

  it('刷卡消費 → 預設 pending、卡負債增加、額度減少', async () => {
    const res = await client.post(
      '/api/mutations',
      envelope('transactions', 'create', uuidv7(), {
        type: 'expense',
        amountMinor: '999',
        currency: 'TWD',
        fromAccountId: cardId,
        categoryAccountId: foodCategoryId,
        merchantRaw: '超市',
        occurredAt: now(),
        source: 'manual',
      }),
    );
    expect(res.status).toBe(200);
    const cycle = (await (await client.get(`/api/cards/${cardId}/cycle`)).json()) as {
      current: { pendingMinor: string; postedMinor: string };
      outstandingMinor: string;
      availableCreditMinor: string;
    };
    expect(cycle.current.pendingMinor).toBe('999');
    expect(cycle.outstandingMinor).toBe('999');
    expect(cycle.availableCreditMinor).toBe('99001'); // 群組額度 100000 − 999
  });

  it('繳款是轉帳：銀行↓、卡債↓，不產生 expense line', async () => {
    const paymentId = uuidv7();
    const res = await client.post(
      '/api/mutations',
      envelope('transactions', 'create', paymentId, {
        type: 'card_payment',
        amountMinor: '999',
        currency: 'TWD',
        fromAccountId: bankId,
        toAccountId: cardId,
        occurredAt: now(),
        source: 'manual',
      }),
    );
    expect(res.status).toBe(200);
    const accounts = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string; balanceMinor: string }> };
    expect(accounts.accounts.find((a) => a.id === bankId)?.balanceMinor).toBe('4001'); // 5000 − 999
    const cycle = (await (await client.get(`/api/cards/${cardId}/cycle`)).json()) as { outstandingMinor: string };
    expect(cycle.outstandingMinor).toBe('0');
    // 分錄無 expense line
    const [entry] = await db
      .select()
      .from(schema.journalEntries)
      .where(eq(schema.journalEntries.transactionId, paymentId));
    const lines = await db.select().from(schema.journalLines).where(eq(schema.journalLines.entryId, entry!.id));
    expect(lines).toHaveLength(2);
    const lineAccounts = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, entry!.userId));
    const kinds = lines.map((l) => lineAccounts.find((a) => a.id === l.accountId)?.kind);
    expect(kinds).not.toContain('expense');
  });
});

describe('週期規則與預計交易（RECUR、F5 手動確認）', () => {
  const ruleId = uuidv7();
  let expectedId = '';
  let expectedVersion = 1;

  it('建立每月規則 → 自動長出 scheduled 預計交易', async () => {
    const res = await client.post(
      '/api/mutations',
      envelope('recurring_rules', 'create', ruleId, {
        name: 'Netflix',
        schedule: { freq: 'monthly', interval: 1, dayOfMonth: 22 },
        amountMinor: '390',
        currency: 'TWD',
        amountToleranceMinor: '20',
        dateToleranceDays: 3,
        accountId: cardId,
        categoryAccountId: foodCategoryId,
        active: true,
        nextExpectedDate: '2026-07-22',
      }),
    );
    expect(res.status).toBe(200);
    const rec = (await (await client.get('/api/recurring')).json()) as {
      rules: Array<{ id: string }>;
      expected: Array<{ id: string; expectedDate: string; status: string; version: number }>;
    };
    expect(rec.rules.some((r) => r.id === ruleId)).toBe(true);
    const exp = rec.expected.find((e) => e.expectedDate === '2026-07-22');
    expect(exp?.status).toBe('scheduled');
    expectedId = exp!.id;
    expectedVersion = exp!.version;
  });

  it('確認預計交易 → 轉正式交易、規則推進到下一期', async () => {
    const realTxnId = uuidv7();
    await client.post(
      '/api/mutations',
      envelope('transactions', 'create', realTxnId, {
        type: 'expense',
        amountMinor: '390',
        currency: 'TWD',
        fromAccountId: cardId,
        categoryAccountId: foodCategoryId,
        merchantRaw: 'Netflix',
        occurredAt: now(),
        expectedTransactionId: expectedId,
        recurringRuleId: ruleId,
        source: 'recurring',
      }),
    );
    const res = await client.post(
      '/api/mutations',
      envelope('expected_transactions', 'update', expectedId, { status: 'confirmed', matchedTransactionId: realTxnId }, expectedVersion),
    );
    expect(res.status).toBe(200);

    const rec = (await (await client.get('/api/recurring')).json()) as {
      rules: Array<{ id: string; nextExpectedDate: string }>;
      expected: Array<{ expectedDate: string; status: string }>;
    };
    expect(rec.rules.find((r) => r.id === ruleId)?.nextExpectedDate).toBe('2026-08-22');
    expect(rec.expected.some((e) => e.expectedDate === '2026-08-22' && e.status === 'scheduled')).toBe(true);
  });

  it('非法狀態轉移被拒（confirmed → scheduled）', async () => {
    const res = await client.post(
      '/api/mutations',
      envelope('expected_transactions', 'update', expectedId, { status: 'scheduled' }, expectedVersion + 1),
    );
    expect(res.status).toBe(422);
  });
});

describe('user_id 隔離（SEC-6 M1：所有查詢/寫入以 user_id 界定）', () => {
  it('引用其他使用者的帳戶 → 拒絕', async () => {
    const { userId: otherUserId } = await createUserWithDefaults(db, {
      email: 'other@example.com',
      displayName: null,
      passwordHash: 'not-a-real-hash',
      ledgerTimeZone: 'Asia/Taipei',
    });
    const otherAccountId = uuidv7();
    await applyMutation(
      db,
      { id: otherUserId, ledgerTimeZone: 'Asia/Taipei' },
      {
        mutationId: uuidv7(),
        deviceId: uuidv7(),
        entity: 'accounts',
        entityId: otherAccountId,
        op: 'create',
        baseVersion: null,
        payload: { subtype: 'bank', name: '別人的銀行', currency: 'TWD' },
        clientAt: now(),
      },
    );
    // user1 嘗試從別人的帳戶記支出
    const res = await client.post(
      '/api/mutations',
      envelope('transactions', 'create', uuidv7(), {
        type: 'expense',
        amountMinor: '100',
        currency: 'TWD',
        fromAccountId: otherAccountId,
        categoryAccountId: foodCategoryId,
        occurredAt: now(),
        source: 'manual',
      }),
    );
    expect(res.status).toBe(422); // ACCOUNT_NOT_FOUND（以 user_id 界定查不到）
    // user1 的清單看不到別人的帳戶
    const accounts = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string }> };
    expect(accounts.accounts.some((a) => a.id === otherAccountId)).toBe(false);
  });
});

describe('audit log 全寫入路徑（SYNC-6）與匯出完整性（SYNC-8）', () => {
  it('每個 applied mutation 都有對應 audit log', async () => {
    const applied = await db
      .select()
      .from(schema.syncMutations)
      .where(eq(schema.syncMutations.result, 'applied'));
    expect(applied.length).toBeGreaterThan(5);
    const audits = await db.select().from(schema.auditLogs).where(isNotNull(schema.auditLogs.mutationId));
    const auditMutationIds = new Set(audits.map((a) => a.mutationId));
    for (const m of applied) {
      expect(auditMutationIds.has(m.mutationId), `mutation ${m.entity}:${m.op} 缺 audit log`).toBe(true);
    }
  });

  it('JSON 匯出：建過的資料都在、欄位齊全', async () => {
    const res = await client.get('/api/export/json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      formatVersion: number;
      data: Record<string, Array<Record<string, unknown>>>;
    };
    expect(body.formatVersion).toBe(1);
    for (const key of [
      'accounts',
      'account_groups',
      'credit_cards',
      'credit_limit_groups',
      'transactions',
      'transaction_links',
      'journal_entries',
      'journal_lines',
      'recurring_rules',
      'expected_transactions',
      'audit_logs',
      'exchange_rates',
    ]) {
      expect(body.data[key], `匯出缺 ${key}`).toBeDefined();
    }
    expect(body.data['accounts']!.some((a) => a['id'] === bankId)).toBe(true);
    expect(body.data['credit_cards']!.some((c) => c['accountId'] === cardId)).toBe(true);
    expect(body.data['journal_lines']!.length).toBeGreaterThan(0);
    // 金額是字串（不是 float）
    const txn = body.data['transactions']![0]!;
    expect(typeof txn['amountMinor']).toBe('string');
    // 軟刪除的資料也匯出（資料所有權）
    expect(body.data['transactions']!.some((t) => t['deletedAt'] !== null)).toBe(true);
  });

  it('CSV 匯出：回傳 zip', async () => {
    const res = await client.get('/api/export/csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/zip');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(100);
    expect(buf[0]).toBe(0x50); // 'P'
    expect(buf[1]).toBe(0x4b); // 'K'（zip magic）
  });
});

describe('帳戶刪除（軟刪除；有帳務紀錄則拒絕、引導封存）', () => {
  it('沒用過的帳戶可刪除，從清單消失', async () => {
    const id = uuidv7();
    const created = await client.post('/api/mutations', envelope('accounts', 'create', id, { subtype: 'cash', name: '誤建帳戶', currency: 'TWD' }));
    expect(created.status).toBe(200);
    const del = await client.post('/api/mutations', envelope('accounts', 'delete', id, {}, 1));
    expect(await del.json()).toMatchObject({ result: 'applied' });
    const list = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string }> };
    expect(list.accounts.some((a) => a.id === id)).toBe(false);
  });

  it('有帳務紀錄的帳戶 → ACCOUNT_IN_USE', async () => {
    const list = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string; version: number }> };
    const bank = list.accounts.find((a) => a.id === bankId);
    expect(bank).toBeTruthy();
    const del = await client.post('/api/mutations', envelope('accounts', 'delete', bankId, {}, bank!.version));
    const body = (await del.json()) as { result: string; error?: { code: string } };
    expect(body.result).toBe('rejected_invalid');
    expect(body.error?.code).toBe('ACCOUNT_IN_USE');
  });

  it('schema 驗證失敗也回 rejected_invalid 信封（否則 client outbox 會卡死重試）', async () => {
    const env = envelope('accounts', 'create', uuidv7(), {
      subtype: 'bank', name: '期初零元戶', currency: 'TWD',
      opening: { transactionId: uuidv7(), amountMinor: '0', isLiability: false },
    });
    const res = await client.post('/api/mutations', env);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { mutationId?: string; result?: string; error?: { code: string } };
    expect(body.result).toBe('rejected_invalid');
    expect(body.mutationId).toBe((env as { mutationId: string }).mutationId);
    expect(body.error?.code).toBe('INVALID_PAYLOAD');
  });
});

describe('帳戶 institution（所屬機構）', () => {
  it('建立時可帶機構、清單回傳、更新可改', async () => {
    const id = uuidv7();
    await client.post('/api/mutations', envelope('accounts', 'create', id, { subtype: 'bank', name: '薪轉戶', institution: '彼岸花銀行', currency: 'TWD' }));
    let list = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string; institution: string | null; version: number }> };
    let row = list.accounts.find((a) => a.id === id);
    expect(row?.institution).toBe('彼岸花銀行');
    await client.post('/api/mutations', envelope('accounts', 'update', id, { institution: '曼珠沙華銀行' }, row!.version));
    list = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string; institution: string | null; version: number }> };
    row = list.accounts.find((a) => a.id === id);
    expect(row?.institution).toBe('曼珠沙華銀行');
  });

  it('投資帳戶帶券商 → 配對建立的交割／資產帳戶都寫入', async () => {
    const invId = uuidv7();
    const res = await client.post(
      '/api/mutations',
      envelope('investment_accounts', 'create', invId, { name: '彼岸花投資', institution: '彼岸花證券', currency: 'TWD' }),
    );
    expect(res.status).toBe(200);
    const list = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ subtype: string; institution: string | null; name: string }> };
    const settlement = list.accounts.find((a) => a.subtype === 'brokerage_settlement' && a.name === '彼岸花投資 交割');
    const asset = list.accounts.find((a) => a.subtype === 'investment_asset' && a.name === '彼岸花投資');
    expect(settlement?.institution).toBe('彼岸花證券');
    expect(asset?.institution).toBe('彼岸花證券');
  });
});
