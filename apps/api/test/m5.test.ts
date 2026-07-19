import { rm } from 'node:fs/promises';
import type { Db } from '@okane-dokoitta/database';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { ApiEnv } from '../src/env.js';
import { runNotificationScan } from '../src/notification-scheduler.js';
import { createTestDb, TestClient, testEnv } from './helpers.js';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

let discordKeyPair: CryptoKeyPair;
let discordPublicKeyHex: string;

async function signInteraction(body: unknown): Promise<{ body: string; signature: string; timestamp: string }> {
  const bodyText = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = new TextEncoder().encode(timestamp + bodyText);
  const signature = await crypto.subtle.sign('Ed25519', discordKeyPair.privateKey, message);
  return { body: bodyText, signature: bytesToHex(new Uint8Array(signature)), timestamp };
}

let db: Db;
let client: TestClient;
let env: ApiEnv;
const deviceId = uuidv7();

beforeAll(async () => {
  discordKeyPair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  const rawPublicKey = (await crypto.subtle.exportKey('raw', discordKeyPair.publicKey)) as ArrayBuffer;
  discordPublicKeyHex = bytesToHex(new Uint8Array(rawPublicKey));

  env = {
    ...testEnv(),
    dataDir: `${process.cwd()}/.test-data-m5`,
    discord: { appId: 'test-app-id', publicKey: discordPublicKeyHex, botToken: 'test-bot-token', clientSecret: 'test-client-secret' },
  };
  await rm(env.dataDir, { recursive: true, force: true });
  db = await createTestDb();
  const app = createApp(db, env);
  client = new TestClient((request) => app.fetch(request));
  const setup = await client.post('/api/auth/setup', { email: 'discord@example.com', password: 'discord-password-123' });
  client.csrfToken = ((await setup.json()) as { csrfToken: string }).csrfToken;
  await client.post('/api/sync/devices/register', { id: deviceId, name: 'Discord test browser', platform: 'test' });
}, 120_000);

afterAll(async () => {
  await rm(env.dataDir, { recursive: true, force: true });
});

function mutation(entity: string, op: string, entityId: string, payload: Record<string, unknown>, baseVersion: number | null = null) {
  return { mutationId: uuidv7(), deviceId, entity, entityId, op, baseVersion, payload, clientAt: new Date().toISOString() };
}

const DISCORD_USER = { id: 'discord-user-1', username: 'tinyyana' };

function pingInteraction() {
  return { type: 1 };
}

function financeCommand(name: string, options: Array<{ name: string; value?: string | number }> = []) {
  return {
    type: 2,
    data: { name: 'finance', options: [{ name, options }] },
    user: DISCORD_USER,
  };
}

async function postInteraction(payload: unknown): Promise<Response> {
  const signed = await signInteraction(payload);
  return client.appFetchRaw('/api/discord/interactions', {
    'X-Signature-Ed25519': signed.signature,
    'X-Signature-Timestamp': signed.timestamp,
  }, signed.body);
}

describe('M5 Discord：簽章驗證、帳號連結、指令、通知偏好', () => {
  it('PING 回 PONG', async () => {
    const res = await postInteraction(pingInteraction());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  it('簽章錯誤一律拒絕（401）', async () => {
    const res = await client.appFetchRaw(
      '/api/discord/interactions',
      { 'X-Signature-Ed25519': '00'.repeat(64), 'X-Signature-Timestamp': String(Math.floor(Date.now() / 1000)) },
      JSON.stringify(pingInteraction()),
    );
    expect(res.status).toBe(401);
  });

  it('未連結帳號呼叫指令 → 回覆一次性連結 URL', async () => {
    const res = await postInteraction(financeCommand('status'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { content: string; flags: number } };
    expect(body.data.flags).toBe(64); // ephemeral
    expect(body.data.content).toContain('/api/discord/link/consume?token=');
  });

  it('登入中的瀏覽器打開連結 token → 完成綁定', async () => {
    const promptRes = await postInteraction(financeCommand('status'));
    const promptBody = (await promptRes.json()) as { data: { content: string } };
    const token = /token=([\w-]+)/.exec(promptBody.data.content)?.[1];
    expect(token).toBeTruthy();
    const consumeRes = await client.get(`/api/discord/link/consume?token=${token}`);
    expect(consumeRes.status).toBe(302);
    expect(consumeRes.headers.get('location')).toContain('discordLinked=1');

    const status = (await (await client.get('/api/discord/status')).json()) as { linked: boolean; discordUsername: string | null };
    expect(status.linked).toBe(true);
    expect(status.discordUsername).toBe('tinyyana');

    const replay = await client.get(`/api/discord/link/consume?token=${token}`);
    expect(replay.headers.get('location')).toContain('discordError=token_expired'); // 同一 token 不能重複兌換
  });

  it('已連結：/finance status 回傳淨資產摘要（ephemeral）', async () => {
    const res = await postInteraction(financeCommand('status'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { content: string; flags: number } };
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain('淨資產');
  });

  it('/finance add 建立草稿交易（needs_review, source=discord_draft）', async () => {
    await createCashAccount(); // 預設帳戶只有分類，沒有可花費帳戶，/finance add 需要至少一個
    const res = await postInteraction(financeCommand('add', [{ name: 'amount', value: 120 }, { name: 'note', value: '午餐' }]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { content: string } };
    expect(body.data.content).toContain('草稿已建立');

    const txns = (await (await client.get('/api/transactions')).json()) as {
      transactions: Array<{ amountMinor: string; needsReview: boolean; source: string; status: string; merchantRaw: string | null }>;
    };
    const draft = txns.transactions.find((t) => t.merchantRaw === '午餐');
    expect(draft).toBeTruthy();
    expect(draft?.amountMinor).toBe('120');
    expect(draft?.needsReview).toBe(true);
    expect(draft?.source).toBe('discord_draft');
    expect(draft?.status).toBe('draft');
  });

  it('/finance add 金額格式錯誤時給出錯誤訊息，不建立交易', async () => {
    const res = await postInteraction(financeCommand('add', [{ name: 'amount', value: 'abc' }, { name: 'note', value: '壞掉的' }]));
    const body = (await res.json()) as { data: { content: string } };
    expect(body.data.content).toContain('金額格式不對');
  });

  it('/finance confirm 列出待確認清單並可用按鈕確認入帳', async () => {
    const accountsResult = (await (await client.get('/api/accounts')).json()) as {
      accounts: Array<{ id: string; subtype: string; name: string }>;
    };
    const cashAccount = accountsResult.accounts.find((a) => a.subtype === 'cash' || a.subtype === 'bank');
    const cashId = cashAccount?.id ?? (await createCashAccount());
    const categoryId = accountsResult.accounts.find((a) => a.subtype === 'category_expense')!.id;

    const ruleId = uuidv7();
    await client.post(
      '/api/mutations',
      mutation('recurring_rules', 'create', ruleId, {
        name: 'Netflix',
        schedule: { freq: 'monthly', interval: 1, dayOfMonth: 1 },
        amountMinor: '390',
        currency: 'TWD',
        amountToleranceMinor: '0',
        dateToleranceDays: 3,
        accountId: cashId,
        categoryAccountId: categoryId,
        active: true,
        nextExpectedDate: '2026-08-01',
      }),
    );
    const recurring = (await (await client.get('/api/recurring')).json()) as {
      expected: Array<{ id: string; ruleId: string; version: number }>;
    };
    const expectedRow = recurring.expected.find((e) => e.ruleId === ruleId)!;
    expect(expectedRow).toBeTruthy();

    const listRes = await postInteraction(financeCommand('confirm'));
    const listBody = (await listRes.json()) as { data: { components: Array<{ components: Array<{ custom_id: string }> }> } };
    const customId = listBody.data.components[0]?.components.find((btn) => btn.custom_id === `confirm:${expectedRow.id}`)?.custom_id;
    expect(customId).toBe(`confirm:${expectedRow.id}`);

    const clickRes = await postInteraction({ type: 3, data: { custom_id: customId }, user: DISCORD_USER });
    const clickBody = (await clickRes.json()) as { data: { content: string } };
    expect(clickBody.data.content).toContain('已確認並記帳');

    const afterRecurring = (await (await client.get('/api/recurring')).json()) as {
      expected: Array<{ id: string; status: string }>;
    };
    expect(afterRecurring.expected.some((e) => e.id === expectedRow.id)).toBe(false); // 已 confirmed，不在待處理清單
  });

  it('撤銷連結後指令回覆連結提示', async () => {
    await client.post('/api/discord/revoke');
    const res = await postInteraction(financeCommand('status'));
    const body = (await res.json()) as { data: { content: string } };
    expect(body.data.content).toContain('/api/discord/link/consume?token=');
    const status = (await (await client.get('/api/discord/status')).json()) as { linked: boolean };
    expect(status.linked).toBe(false);
  });

  it('管理者可用正式站現有的 env.discord 重新註冊 /finance 指令，不用另外貼 Bot Token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === `https://discord.com/api/v10/applications/${env.discord!.appId}/commands`) {
        expect(init?.method).toBe('PUT');
        expect((init?.headers as Record<string, string>)['Authorization']).toBe(`Bot ${env.discord!.botToken}`);
        const body = JSON.parse(String(init?.body)) as Array<{ name: string }>;
        expect(body[0]?.name).toBe('finance');
        return new Response('{}', { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    try {
      const res = await client.post('/api/discord/admin/register-commands');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; commandCount: number };
      expect(body).toMatchObject({ ok: true, commandCount: 1 });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('未登入不能觸發指令註冊', async () => {
    const anon = new TestClient((request) => createApp(db, env).fetch(request));
    const res = await anon.post('/api/discord/admin/register-commands');
    expect(res.status).toBe(401);
  });

  async function createCashAccount(): Promise<string> {
    const id = uuidv7();
    await client.post('/api/mutations', mutation('accounts', 'create', id, { kind: 'asset', subtype: 'cash', name: '現金', currency: 'TWD' }));
    return id;
  }
});

describe('M5 通知偏好設定 API', () => {
  it('GET 回傳預設值（fuzzy + 兩通道皆開）', async () => {
    const prefs = (await (await client.get('/api/notifications/preferences')).json()) as {
      privacyMode: string;
      discordEnabled: boolean;
      webPushEnabled: boolean;
      webPushVapidPublicKey: string | null;
    };
    expect(prefs.privacyMode).toBe('fuzzy');
    expect(prefs.discordEnabled).toBe(true);
    expect(prefs.webPushEnabled).toBe(true);
    expect(prefs.webPushVapidPublicKey).toBeNull(); // 測試環境未設定 VAPID
  });

  it('更新後 GET 反映變更', async () => {
    const putRes = await client.post('/api/notifications/preferences', {
      privacyMode: 'full',
      quietHoursStartMinute: 22 * 60,
      quietHoursEndMinute: 7 * 60,
      mutedEventTypes: ['price_stale'],
    });
    expect(putRes.status).toBe(200);
    const prefs = (await (await client.get('/api/notifications/preferences')).json()) as {
      privacyMode: string;
      quietHoursStartMinute: number | null;
      mutedEventTypes: string[];
    };
    expect(prefs.privacyMode).toBe('full');
    expect(prefs.quietHoursStartMinute).toBe(22 * 60);
    expect(prefs.mutedEventTypes).toEqual(['price_stale']);
  });

  it('未設定 VAPID 時訂閱 Web Push 回 503', async () => {
    const res = await client.post('/api/notifications/web-push/subscribe', {
      endpoint: 'https://example.com/push/abc',
      keys: { p256dh: 'x'.repeat(20), auth: 'y'.repeat(10) },
    });
    expect(res.status).toBe(503);
  });
});

describe('M5 通知排程：偵測、去重、冷卻、quiet hours', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;

  beforeAll(async () => {
    // 重新連結 Discord（上一個 describe 結尾撤銷過）；直接寫 DB，不必真的過 OAuth
    const me = (await (await client.get('/api/me')).json()) as { userId: string };
    const { upsertDiscordLink, newId: newIdFn } = await import('@okane-dokoitta/database');
    await upsertDiscordLink(db, { id: newIdFn(), userId: me.userId, discordUserId: DISCORD_USER.id, discordUsername: DISCORD_USER.username });

    const accountsResult = (await (await client.get('/api/accounts')).json()) as { accounts: Array<{ id: string; subtype: string }> };
    const accountId = accountsResult.accounts.find((a) => a.subtype === 'cash')!.id;
    const categoryId = accountsResult.accounts.find((a) => a.subtype === 'category_expense')!.id;

    await client.post(
      '/api/mutations',
      mutation('recurring_rules', 'create', uuidv7(), {
        name: '房租',
        schedule: { freq: 'monthly', interval: 1, dayOfMonth: 1 },
        amountMinor: '15000',
        currency: 'TWD',
        amountToleranceMinor: '0',
        dateToleranceDays: 3,
        accountId,
        categoryAccountId: categoryId,
        active: true,
        nextExpectedDate: '2026-01-01', // 過去日期 → 產生的 expected 已逾期
      }),
    );
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('逾期未確認的預計交易觸發 Discord 通知，且同一時間點再掃一次不重發（dedup）', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/users/@me/channels')) return new Response(JSON.stringify({ id: 'dm-channel-1' }), { status: 200 });
      if (url.includes('/channels/dm-channel-1/messages')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });

    const now = new Date('2026-07-18T04:00:00.000Z'); // 台北時間 12:00，非 quiet hours
    const firstScan = await runNotificationScan(db, env, now);
    expect(firstScan.sent).toBeGreaterThan(0);
    const dmCall = fetchSpy.mock.calls.find(([input]) => String(input).includes('/channels/dm-channel-1/messages'));
    expect(dmCall).toBeTruthy();

    fetchSpy.mockClear();
    const secondScan = await runNotificationScan(db, env, now); // 同一時間點再跑一次：dedup 應阻擋重發
    expect(secondScan.sent).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('quiet hours 期間即使有候選事件也不發送', async () => {
    await client.post('/api/notifications/preferences', { quietHoursStartMinute: 0, quietHoursEndMinute: 23 * 60 + 59 });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const now = new Date('2026-07-25T04:00:00.000Z'); // 冷卻期（3 天）已過，理論上會有候選，但 quiet hours 應擋下
    const result = await runNotificationScan(db, env, now);
    expect(result.sent).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    await client.post('/api/notifications/preferences', { quietHoursStartMinute: null, quietHoursEndMinute: null });
  });
});
