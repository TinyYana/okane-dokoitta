import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
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
const cardId = uuidv7();
const transactionId = uuidv7();
let sessionId = '';
let importFileId = '';
let importStoragePath = '';
let categoryId = '';
let incomeCategoryId = '';

beforeAll(async () => {
  await rm(env.dataDir, { recursive: true, force: true });
  db = await createTestDb();
  const app = createApp(db, env);
  client = new TestClient((request) => app.fetch(request));
  const setup = await client.post('/api/auth/setup', { email: 'audit@example.com', password: 'audit-password-123' });
  client.csrfToken = ((await setup.json()) as { csrfToken: string }).csrfToken;
  await client.post('/api/sync/devices/register', { id: deviceId, name: 'Audit browser', platform: 'test' });
}, 120_000);

afterAll(async () => {
  await rm(env.dataDir, { recursive: true, force: true });
});

function mutation(entity: string, op: string, entityId: string, payload: Record<string, unknown>, baseVersion: number | null = null) {
  return { mutationId: uuidv7(), deviceId, entity, entityId, op, baseVersion, payload, clientAt: new Date().toISOString() };
}

describe('M3 帳單匯入 → 審計 → proposed patch', () => {
  it('建立信用卡與可配對帳本交易', async () => {
    const accounts = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string; subtype: string }> };
    categoryId = accounts.accounts.find((account) => account.subtype === 'category_expense')!.id;
    incomeCategoryId = accounts.accounts.find((account) => account.subtype === 'category_income')!.id;
    const card = await client.post('/api/mutations', mutation('accounts', 'create', cardId, {
      subtype: 'credit_card',
      name: '審計測試卡',
      currency: 'TWD',
      creditCard: { issuer: '測試銀行', cardName: 'Signal', last4: '2468', statementDay: 15, dueDay: 3, status: 'active' },
    }));
    expect(card.status).toBe(200);
    const transaction = await client.post('/api/mutations', mutation('transactions', 'create', transactionId, {
      type: 'expense', amountMinor: '999', currency: 'TWD', fromAccountId: cardId, categoryAccountId: categoryId,
      merchantRaw: '超市', occurredAt: '2026-07-10T12:00:00.000Z', source: 'manual',
    }));
    expect(transaction.status).toBe(200);
  });

  it('聯邦多卡 CSV：一份原始檔建立 group，依末四碼拆成每卡 statement/session', async () => {
    const unionCardA = uuidv7();
    const unionCardB = uuidv7();
    for (const [id, last4, name] of [[unionCardA, '2468', '彼岸花卡'], [unionCardB, '1357', '夜櫻卡']] as const) {
      expect((await client.post('/api/mutations', mutation('accounts', 'create', id, {
        subtype: 'credit_card', name, currency: 'TWD',
        creditCard: { issuer: '聯邦銀行', cardName: name, last4, statementDay: 15, dueDay: 3, status: 'active' },
      }))).status).toBe(200);
    }
    const text = [
      '帳單結帳日,繳款截止日,上期應繳總額,上期已繳金額,前期餘額,本期新增(含調整)款項,本期應繳金額,本期最低應繳金額',
      '115/08/15,115/09/03,0,0,0,300,300,30',
      '入帳日,消費日,消費明細,結匯日,幣別,外幣金額,新臺幣金額,',
      ',,彼岸花卡－正卡  2468,,,,,',
      '08/02,08/01,彼岸花書店,,,,100,',
      ',,夜櫻卡－正卡  1357,,,,,',
      '08/03,08/02,月光商店,,,,200,',
      ',,總計,,,,300,',
    ].join('\n');
    const imported = await client.post('/api/audit/import', {
      kind: 'csv', text, filename: 'union-sanitized.csv', importerId: 'auto', creditCardAccountId: cardId,
      defaults: { currency: 'TWD' },
    });
    expect(imported.status).toBe(201);
    const body = (await imported.json()) as { groupId: string; sessions: Array<{ sessionId: string; statementId: string }> };
    expect(body.sessions).toHaveLength(2);
    const [groups, files, childStatements, childSessions] = await Promise.all([
      db.select().from(schema.statementGroups).where(eq(schema.statementGroups.id, body.groupId)),
      db.select().from(schema.importFiles),
      db.select().from(schema.statements).where(eq(schema.statements.groupId, body.groupId)),
      db.select().from(schema.auditSessions),
    ]);
    expect(groups[0]?.totalMinor).toBe(300n);
    expect(files).toHaveLength(1);
    expect(childStatements.map((row) => row.totalMinor).sort((a, b) => Number(a - b))).toEqual([100n, 200n]);
    expect(childStatements.map((row) => row.creditCardAccountId).sort()).toEqual([unionCardA, unionCardB].sort());
    expect(childSessions.filter((row) => body.sessions.some((item) => item.sessionId === row.id))).toHaveLength(2);
  });

  it('信用卡回饋以 income-to-card 入帳後，可與聯邦負額回饋行精確配對', async () => {
    const unionCards = await db
      .select({ accountId: schema.creditCards.accountId })
      .from(schema.creditCards)
      .where(eq(schema.creditCards.last4, '2468'));
    const unionCardId = unionCards.find((row) => row.accountId !== cardId)!.accountId;
    const rewardTransactionId = uuidv7();
    expect((await client.post('/api/mutations', mutation('transactions', 'create', rewardTransactionId, {
      type: 'income', amountMinor: '50', currency: 'TWD', toAccountId: unionCardId, categoryAccountId: incomeCategoryId,
      merchantRaw: '信用卡回饋', occurredAt: '2026-09-02T12:00:00.000Z', source: 'manual',
    }))).status).toBe(200);
    const text = [
      '帳單結帳日,繳款截止日,上期應繳總額,上期已繳金額,前期餘額,本期新增(含調整)款項,本期應繳金額,本期最低應繳金額',
      '115/09/15,115/10/03,0,0,0,-50,-50,0',
      '入帳日,消費日,消費明細,結匯日,幣別,外幣金額,新臺幣金額,',
      ',,彼岸花卡－正卡  2468,,,,,',
      '09/02,09/02,信用卡回饋,,,,-50,',
      ',,總計,,,,-50,',
    ].join('\n');
    const imported = await client.post('/api/audit/import', {
      kind: 'csv', text, filename: 'union-reward.csv', importerId: 'auto', creditCardAccountId: cardId,
      defaults: { currency: 'TWD' },
    });
    expect(imported.status).toBe(201);
    const rewardSessionId = ((await imported.json()) as { sessionId: string }).sessionId;
    const detail = (await (await client.get(`/api/audit/sessions/${rewardSessionId}`)).json()) as {
      candidates: Array<{ kind: string; transactionId: string | null }>;
    };
    expect(detail.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'match', transactionId: rewardTransactionId }),
    ]));
  });

  it('generic CSV 寫入加密原始檔並建立可續作審計', async () => {
    const imported = await client.post('/api/audit/import', {
      kind: 'csv',
      text: 'date,merchant,amount\n2026-07-10,超市,999',
      filename: 'sanitized.csv',
      importerId: 'generic-csv',
      creditCardAccountId: cardId,
      columns: { occurredAt: 'date', merchant: 'merchant', amount: 'amount' },
      defaults: {
        currency: 'TWD', periodStart: '2026-07-01', periodEnd: '2026-07-31',
        statementDate: '2026-07-15', dueDate: '2026-08-03', total: '999',
      },
    });
    expect(imported.status).toBe(201);
    sessionId = ((await imported.json()) as { sessionId: string }).sessionId;
    const detail = (await (await client.get(`/api/audit/sessions/${sessionId}`)).json()) as {
      file: { id: string; storagePath: string };
      candidates: Array<{ kind: string; transactionId: string | null }>;
      patches: Array<{ status: string; kind: string }>;
    };
    importFileId = detail.file.id;
    importStoragePath = detail.file.storagePath;
    expect(detail.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'match', transactionId })]));
    expect(detail.patches).toEqual([expect.objectContaining({ kind: 'assign_statement', status: 'proposed' })]);
    expect(detail.patches).toHaveLength(detail.candidates.length);
    const encrypted = await readFile(join(env.dataDir, detail.file.storagePath));
    expect(encrypted.subarray(0, 8).toString()).toBe('ODKFILE1');
    expect(encrypted.includes(Buffer.from('超市'))).toBe(false);
    const logs = await db.select().from(schema.auditLogs);
    for (const entity of ['import_files', 'statements', 'statement_items', 'audit_sessions', 'audit_candidates', 'proposed_patches']) {
      expect(logs.some((log) => log.entity === entity)).toBe(true);
    }
  });

  it('帳單缺漏可經 patch 建成待複核交易，並保留帳單與 audit/change 連結', async () => {
    const imported = await client.post('/api/audit/import', {
      kind: 'csv', text: 'date,merchant,amount\n2026-07-20,遊戲,123', filename: 'unresolved.csv', importerId: 'generic-csv',
      creditCardAccountId: cardId, columns: { occurredAt: 'date', merchant: 'merchant', amount: 'amount' },
      defaults: {
        currency: 'TWD', periodStart: '2026-07-01', periodEnd: '2026-07-31',
        statementDate: '2026-07-20', dueDate: '2026-08-08', total: '123',
      },
    });
    expect(imported.status).toBe(201);
    const unresolvedSessionId = ((await imported.json()) as { sessionId: string }).sessionId;
    const detail = (await (await client.get(`/api/audit/sessions/${unresolvedSessionId}`)).json()) as {
      candidates: Array<{ id: string; kind: string; decision: string }>;
      patches: Array<{ id: string; candidateId: string; kind: string; payload: { transactionId?: string; categoryAccountId?: string } }>;
    };
    expect(detail.candidates.length).toBeGreaterThan(0);
    expect(detail.patches).toHaveLength(detail.candidates.length);
    const patch = detail.patches.find((item) => item.kind === 'create_transaction')!;
    expect(patch.payload.categoryAccountId).toBeTruthy();
    expect((await client.post(`/api/audit/patches/${patch.id}/decision`, { accept: true })).status).toBe(200);
    const refreshed = (await (await client.get(`/api/audit/sessions/${unresolvedSessionId}`)).json()) as {
      session: { stats: { differenceMinor: string } };
      candidates: Array<{ id: string; decision: string }>;
    };
    expect(refreshed.candidates.find((candidate) => candidate.id === patch.candidateId)?.decision).toBe('accepted');
    expect(refreshed.session.stats.differenceMinor).toBe('0');
    const [created] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, patch.payload.transactionId!));
    expect(created).toMatchObject({ source: 'patch', needsReview: true, statementId: expect.any(String) });
    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, patch.payload.transactionId!));
    expect(logs.some((log) => log.actor === 'patch' && log.action === 'create')).toBe(true);
  });

  it('帳單信用卡回饋建立為專屬收入，不冒充退款', async () => {
    const imported = await client.post('/api/audit/import', {
      kind: 'csv', text: 'date,merchant,amount\n2026-07-21,現金回饋,-50', filename: 'reward.csv', importerId: 'generic-csv',
      creditCardAccountId: cardId, columns: { occurredAt: 'date', merchant: 'merchant', amount: 'amount' },
      defaults: {
        currency: 'TWD', periodStart: '2026-07-01', periodEnd: '2026-07-31',
        statementDate: '2026-07-21', dueDate: '2026-08-08', total: '-50',
      },
    });
    expect(imported.status).toBe(201);
    const rewardSessionId = ((await imported.json()) as { sessionId: string }).sessionId;
    const detail = (await (await client.get(`/api/audit/sessions/${rewardSessionId}`)).json()) as {
      patches: Array<{ id: string; kind: string; payload: { transactionId?: string; transactionType?: string; needsReview?: boolean } }>;
    };
    const patch = detail.patches.find((item) => item.kind === 'create_transaction')!;
    expect(patch.payload).toMatchObject({ transactionType: 'income', needsReview: false });
    expect((await client.post(`/api/audit/patches/${patch.id}/decision`, { accept: true })).status).toBe(200);
    const [created] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, patch.payload.transactionId!));
    expect(created).toMatchObject({ type: 'income', toAccountId: cardId, source: 'patch', needsReview: false });
  });

  it('patch 失敗後可由使用者關閉，不會永久卡住 session', async () => {
    const staleTransactionId = uuidv7();
    expect((await client.post('/api/mutations', mutation('transactions', 'create', staleTransactionId, {
      type: 'expense', amountMinor: '777', currency: 'TWD', fromAccountId: cardId, categoryAccountId: categoryId,
      merchantRaw: '書店', occurredAt: '2026-07-12T12:00:00.000Z', source: 'manual',
    }))).status).toBe(200);
    const imported = await client.post('/api/audit/import', {
      kind: 'csv', text: 'date,merchant,amount\n2026-07-12,書店,777', filename: 'stale.csv', importerId: 'generic-csv',
      creditCardAccountId: cardId, columns: { occurredAt: 'date', merchant: 'merchant', amount: 'amount' },
      defaults: {
        currency: 'TWD', periodStart: '2026-07-01', periodEnd: '2026-07-31',
        statementDate: '2026-07-12', dueDate: '2026-08-01', total: '777',
      },
    });
    const staleSessionId = ((await imported.json()) as { sessionId: string }).sessionId;
    const detail = (await (await client.get(`/api/audit/sessions/${staleSessionId}`)).json()) as {
      candidates: Array<{ id: string; transactionId: string | null }>;
      patches: Array<{ id: string; candidateId: string; kind: string }>;
    };
    const candidate = detail.candidates.find((item) => item.transactionId === staleTransactionId)!;
    const patch = detail.patches.find((item) => item.candidateId === candidate.id && item.kind === 'assign_statement')!;
    expect((await client.post('/api/mutations', mutation('transactions', 'delete', staleTransactionId, {}, 1))).status).toBe(200);
    const failed = await client.post(`/api/audit/patches/${patch.id}/decision`, { accept: true });
    expect(await failed.json()).toMatchObject({ status: 'failed', code: 'PATCH_TARGET_UNAVAILABLE' });
    expect((await client.post(`/api/audit/sessions/${staleSessionId}/complete`)).status).toBe(409);
    expect((await client.post(`/api/audit/patches/${patch.id}/decision`, { accept: false })).status).toBe(200);
    expect((await client.post(`/api/audit/patches/${patch.id}/decision`, { accept: false })).status).toBe(404);
    for (const other of detail.patches.filter((item) => item.id !== patch.id)) {
      expect((await client.post(`/api/audit/patches/${other.id}/decision`, { accept: false })).status).toBe(200);
    }
    expect((await client.post(`/api/audit/sessions/${staleSessionId}/complete`)).status).toBe(200);
    expect((await client.post(`/api/audit/patches/${patch.id}/decision`, { accept: false })).status).toBe(404);
  });

  it('未逐項決定前不能完成；接受 patch 後由 domain 寫入並留 audit/change log', async () => {
    expect((await client.post(`/api/audit/sessions/${sessionId}/complete`)).status).toBe(409);
    const detail = (await (await client.get(`/api/audit/sessions/${sessionId}`)).json()) as {
      candidates: Array<{ id: string; kind: string }>;
      patches: Array<{ id: string; candidateId: string }>;
    };
    const match = detail.candidates.find((candidate) => candidate.kind === 'match')!;
    const patch = detail.patches.find((candidatePatch) => candidatePatch.candidateId === match.id)!;
    expect((await client.post(`/api/audit/candidates/${match.id}/decision`, { decision: 'accepted' })).status).toBe(404);
    const concurrent = await Promise.all([
      client.post(`/api/audit/patches/${patch.id}/decision`, { accept: true }),
      client.post(`/api/audit/patches/${patch.id}/decision`, { accept: true }),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 404]);
    for (const candidate of detail.candidates.filter((item) => item.id !== match.id)) {
      const candidatePatch = detail.patches.find((item) => item.candidateId === candidate.id)!;
      expect((await client.post(`/api/audit/patches/${candidatePatch.id}/decision`, { accept: true })).status).toBe(200);
    }
    expect((await client.post(`/api/audit/sessions/${sessionId}/complete`)).status).toBe(200);

    const [transaction] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, transactionId));
    expect(transaction?.statementId).toBeTruthy();
    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, transactionId));
    expect(logs.some((log) => log.actor === 'patch' && log.action === 'assign_statement')).toBe(true);
    const changes = await db.select().from(schema.changeLog).where(eq(schema.changeLog.entityId, transactionId));
    expect(changes.length).toBeGreaterThanOrEqual(2);
  });

  it('可刪除加密原始檔，解析與報告仍保留', async () => {
    await db.update(schema.importFiles).set({ storagePath: '../escape.enc' }).where(eq(schema.importFiles.id, importFileId));
    expect((await client.post(`/api/audit/files/${importFileId}/purge`)).status).toBe(500);
    const [beforeRetry] = await db.select().from(schema.importFiles).where(eq(schema.importFiles.id, importFileId));
    expect(beforeRetry?.status).toBe('parsed');
    await db.update(schema.importFiles).set({ storagePath: importStoragePath }).where(eq(schema.importFiles.id, importFileId));
    expect((await client.post(`/api/audit/files/${importFileId}/purge`)).status).toBe(200);
    const detail = (await (await client.get(`/api/audit/sessions/${sessionId}`)).json()) as { file: { status: string }; items: unknown[] };
    expect(detail.file.status).toBe('purged');
    expect(detail.items).toHaveLength(1);
  });
});
