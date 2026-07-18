import type { Db } from '@okane-dokoitta/database';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { v7 as uuidv7 } from 'uuid';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { generateRecoveryCodes, generateTotpCode, hashRecoveryCode, verifyTotpCode } from '../src/passkey-routes.js';
import { createTestDb, TestClient, testEnv } from './helpers.js';

let db: Db;
let admin: TestClient;
let member: TestClient;
let fetchApp: (request: Request) => Response | Promise<Response>;
const adminDeviceId = uuidv7();
const memberDeviceId = uuidv7();

beforeAll(async () => {
  db = await createTestDb();
  const app = createApp(db, testEnv());
  fetchApp = (request) => app.fetch(request);
  admin = new TestClient(fetchApp, '10.0.0.1');
  member = new TestClient(fetchApp, '10.0.0.2');
}, 120_000);

describe('M2 自架註冊、多使用者隔離與同步', () => {
  it('invite 是預設公開專案註冊政策，first-run 建立管理者', async () => {
    const status = await admin.get('/api/auth/status');
    expect(await status.json()).toMatchObject({ needsSetup: true, registrationMode: 'invite' });
    const setupInput = {
      email: 'admin@example.com',
      password: 'admin-password-123',
      displayName: '管理者',
    };
    const competing = new TestClient(fetchApp, '10.0.0.3');
    const [first, second] = await Promise.all([admin.post('/api/auth/setup', setupInput), competing.post('/api/auth/setup', setupInput)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const winner = first.status === 200 ? admin : competing;
    const response = first.status === 200 ? first : second;
    winner.csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken;
    admin = winner;
    expect((await (await admin.get('/api/me')).json()) as object).toMatchObject({ isAdmin: true });
  });

  it('邀請模式拒絕無碼註冊，管理者建立一次性邀請後可註冊', async () => {
    const denied = await member.post('/api/auth/register', {
      email: 'member@example.com',
      password: 'member-password-123',
    });
    expect(denied.status).toBe(403);

    const invite = await admin.post('/api/account/invites', { expiresInDays: 7 });
    expect(invite.status).toBe(200);
    const { code } = (await invite.json()) as { code: string };
    const registerInput = {
      email: 'member@example.com',
      password: 'member-password-123',
      inviteCode: code,
    };
    const competing = new TestClient(fetchApp, '10.0.0.4');
    const [first, second] = await Promise.all([member.post('/api/auth/register', registerInput), competing.post('/api/auth/register', registerInput)]);
    expect([first.status, second.status].sort()).toEqual([200, 403]);
    const winner = first.status === 200 ? member : competing;
    const response = first.status === 200 ? first : second;
    winner.csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken;
    member = winner;
  });

  it('架設者可切換 open 或 closed，而不改程式碼', async () => {
    const closedApp = createApp(db, { ...testEnv(), registrationMode: 'closed' });
    const closed = new TestClient((request) => closedApp.fetch(request), '10.0.0.5');
    expect((await closed.post('/api/auth/register', { email: 'closed@example.com', password: 'closed-password-123' })).status).toBe(403);

    const openApp = createApp(db, { ...testEnv(), registrationMode: 'open' });
    const open = new TestClient((request) => openApp.fetch(request), '10.0.0.6');
    const result = await open.post('/api/auth/register', { email: 'open@example.com', password: 'open-password-123' });
    expect(result.status).toBe(200);
  });

  it('兩名使用者可註冊裝置，不能讀取或撤銷對方資料', async () => {
    expect((await admin.post('/api/sync/devices/register', {
      id: adminDeviceId,
      name: 'Admin Windows',
      platform: 'test',
    })).status).toBe(200);
    expect((await member.post('/api/sync/devices/register', {
      id: memberDeviceId,
      name: 'Member iPhone',
      platform: 'test',
    })).status).toBe(200);

    const accountId = uuidv7();
    const mutation = await member.post('/api/mutations', {
      mutationId: uuidv7(),
      deviceId: memberDeviceId,
      entity: 'accounts',
      entityId: accountId,
      op: 'create',
      baseVersion: null,
      payload: { subtype: 'bank', name: '成員銀行', currency: 'TWD' },
      clientAt: new Date().toISOString(),
    });
    expect(mutation.status).toBe(200);
    const adminAccounts = (await (await admin.get('/api/accounts')).json()) as { accounts: Array<{ id: string }> };
    expect(adminAccounts.accounts.some((account) => account.id === accountId)).toBe(false);
    expect((await admin.post(`/api/sync/devices/${memberDeviceId}/revoke`)).status).toBe(404);

    const memberFeed = (await (await member.get('/api/sync/changes?since=0')).json()) as {
      changes: Array<{ entityId: string; seq: string }>;
      nextSince: string;
    };
    expect(memberFeed.changes.some((change) => change.entityId === accountId)).toBe(true);
    expect(typeof memberFeed.nextSince).toBe('string');
    const adminFeed = (await (await admin.get('/api/sync/changes?since=0')).json()) as { changes: Array<{ entityId: string }> };
    expect(adminFeed.changes.some((change) => change.entityId === accountId)).toBe(false);
  });

  it('session 清單只回目前使用者，且有可撤銷 public id', async () => {
    const sessions = (await (await member.get('/api/sync/sessions')).json()) as {
      sessions: Array<{ id: string; deviceId: string | null }>;
    };
    expect(sessions.sessions.length).toBeGreaterThan(0);
    expect(sessions.sessions.every((session) => session.id && session.deviceId !== adminDeviceId)).toBe(true);
  });

  it('衍生的預計交易與規則推進都會進 change feed', async () => {
    const accountView = (await (await member.get('/api/accounts')).json()) as { accounts: Array<{ id: string; subtype: string }> };
    const accountId = accountView.accounts.find((account) => account.subtype === 'bank')!.id;
    const categoryAccountId = accountView.accounts.find((account) => account.subtype === 'category_expense')!.id;
    const before = (await (await member.get('/api/sync/changes?since=0')).json()) as { nextSince: string };
    const ruleId = uuidv7();
    const created = await member.post('/api/mutations', {
      mutationId: uuidv7(), deviceId: memberDeviceId, entity: 'recurring_rules', entityId: ruleId, op: 'create', baseVersion: null,
      payload: {
        name: '同步測試', schedule: { freq: 'monthly', interval: 1, dayOfMonth: 18 }, amountMinor: '120', currency: 'TWD',
        amountToleranceMinor: '0', dateToleranceDays: 2, accountId, categoryAccountId, active: true, nextExpectedDate: '2026-07-18',
      }, clientAt: new Date().toISOString(),
    });
    expect(created.status).toBe(200);
    const derived = (await (await member.get(`/api/sync/changes?since=${before.nextSince}`)).json()) as { changes: Array<{ entity: string; entityId: string; version: number }> };
    expect(derived.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: 'recurring_rules', entityId: ruleId }),
      expect.objectContaining({ entity: 'expected_transactions', version: 1 }),
    ]));
    const recurring = (await (await member.get('/api/recurring')).json()) as { expected: Array<{ id: string; ruleId: string; version: number }> };
    const expected = recurring.expected.find((row) => row.ruleId === ruleId)!;
    const cursor = (await (await member.get('/api/sync/changes?since=0')).json()) as { nextSince: string };
    const advanced = await member.post('/api/mutations', {
      mutationId: uuidv7(), deviceId: memberDeviceId, entity: 'expected_transactions', entityId: expected.id, op: 'update', baseVersion: expected.version,
      payload: { status: 'skipped' }, clientAt: new Date().toISOString(),
    });
    expect(advanced.status).toBe(200);
    const advancedFeed = (await (await member.get(`/api/sync/changes?since=${cursor.nextSince}`)).json()) as { changes: Array<{ entity: string; entityId: string }> };
    expect(advancedFeed.changes.some((change) => change.entity === 'recurring_rules' && change.entityId === ruleId)).toBe(true);
    expect(advancedFeed.changes.filter((change) => change.entity === 'expected_transactions').length).toBeGreaterThanOrEqual(2);
  });

  it('TOTP 只能作為密碼登入後的第二步，不能用 Email + 6 位碼直接嘗試', async () => {
    const options = await admin.post('/api/auth/totp/setup/options');
    const setup = (await options.json()) as { challengeId: string; secret: string };
    const code = generateTotpCode(setup.secret);
    expect((await admin.post('/api/auth/totp/setup/verify', { challengeId: setup.challengeId, code })).status).toBe(200);

    const fresh = new TestClient(fetchApp, '10.0.0.7');
    const password = await fresh.post('/api/auth/login', { email: 'admin@example.com', password: 'admin-password-123' });
    const pending = (await password.json()) as { requiresTotp: boolean; challengeId: string; csrfToken?: string };
    expect(pending).toMatchObject({ requiresTotp: true });
    expect(pending.csrfToken).toBeUndefined();
    const completed = await fresh.post('/api/auth/totp/login', { challengeId: pending.challengeId, code: generateTotpCode(setup.secret) });
    expect(completed.status).toBe(200);
    expect((await completed.json()) as object).toEqual(expect.objectContaining({ csrfToken: expect.any(String) }));

    const standalone = await new TestClient(fetchApp, '10.0.0.8').post('/api/auth/totp/login', { email: 'admin@example.com', code });
    expect(standalone.status).toBe(422);
  });
});

describe('Passkey 恢復碼純邏輯', () => {
  it('產生 10 組不重複恢復碼，雜湊正規化大小寫與空白', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(hashRecoveryCode('secret', ` ${codes[0]!.toLowerCase()} `)).toBe(hashRecoveryCode('secret', codes[0]!));
  });

  it('TOTP 符合 RFC 6238 SHA-1 測試向量並容許相鄰時間窗', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(generateTotpCode(secret, 59_000)).toBe('287082');
    expect(verifyTotpCode(secret, '287082', 89_000)).toBe(true);
    expect(verifyTotpCode(secret, '000000', 59_000)).toBe(false);
  });
});

describe('M1 → M3 migration upgrade', () => {
  it('既有 session 會 backfill 可撤銷 public ID 並設為 NOT NULL', async () => {
    const legacy = new PGlite();
    const migration = async (name: string) => legacy.exec(await readFile(new URL(`../../../packages/database/drizzle/${name}`, import.meta.url), 'utf8'));
    await migration('0000_faithful_fat_cobra.sql');
    const userId = uuidv7();
    await legacy.exec(`
      insert into okane_dokoitta.users (id, email) values ('${userId}', 'legacy@example.com');
      insert into okane_dokoitta.sessions (token_hash, user_id, csrf_token, expires_at)
      values ('legacy-token-hash', '${userId}', 'legacy-csrf', now() + interval '1 day');
    `);
    for (const name of ['0001_thankful_emma_frost.sql', '0002_whole_wilson_fisk.sql', '0003_odd_slapstick.sql', '0004_warm_sersi.sql']) await migration(name);
    const result = await legacy.query<{ public_id: string }>('select public_id::text from okane_dokoitta.sessions where token_hash = $1', ['legacy-token-hash']);
    expect(result.rows[0]?.public_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    await expect(legacy.exec(`insert into okane_dokoitta.sessions (token_hash, user_id, csrf_token, expires_at) values ('missing-public-id', '${userId}', 'csrf', now() + interval '1 day')`)).rejects.toThrow();
    await legacy.close();
  }, 120_000);
});
