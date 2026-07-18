import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { type Db } from '@okane-dokoitta/database';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestDb, TestClient, testEnv } from './helpers.js';

let db: Db;
let client: TestClient;
const env = testEnv();
const deviceId = uuidv7();
let cardAccountId = '';
let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>> | undefined;

const CLEANED_LINES = ['2026-07-02|全家便利商店|120|TWD|消費', '2026-07-03|Netflix|390|TWD|消費'].join('\n');

beforeAll(async () => {
  await rm(env.dataDir, { recursive: true, force: true });
  db = await createTestDb();
  const app = createApp(db, env);
  client = new TestClient((request) => app.fetch(request));
  const setup = await client.post('/api/auth/setup', { email: 'ai@example.com', password: 'ai-password-123456' });
  client.csrfToken = ((await setup.json()) as { csrfToken: string }).csrfToken;
  await client.post('/api/sync/devices/register', { id: deviceId, name: 'AI browser', platform: 'test' });
  cardAccountId = uuidv7();
  await client.post('/api/mutations', {
    mutationId: uuidv7(), deviceId, entity: 'accounts', entityId: cardAccountId, op: 'create', baseVersion: null,
    clientAt: new Date().toISOString(),
    payload: {
      subtype: 'credit_card', name: '測試卡', currency: 'TWD',
      creditCard: { issuer: '測試銀行', cardName: '測試卡', last4: null, creditLimitMinor: '100000', limitGroupId: null, statementDay: 15, dueDay: 3, status: 'active' },
    },
  });
}, 120_000);

afterAll(async () => {
  await rm(env.dataDir, { recursive: true, force: true });
});

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

function mockUpstream(content: string) {
  const implementation = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (fetchSpy) fetchSpy.mockImplementation(implementation);
  else fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(implementation);
}

describe('M6 AI 輔助層（BYOK、AI-1~4）', () => {
  it('未啟用時 AI 端點回 409，核心功能不受影響（AI-1）', async () => {
    const res = await client.post('/api/ai/extract-statement', { text: '隨便的帳單文字' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AI_DISABLED');
  });

  it('可在尚未啟用前測試已儲存的端點；不完整設定不能啟用', async () => {
    const invalid = await client.post('/api/ai/settings', { enabled: true, baseUrl: '', model: '' });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ error: { code: 'AI_SETTINGS_INCOMPLETE' } });

    expect((await client.post('/api/ai/settings', {
      enabled: false, baseUrl: 'https://ai.example.com/v1/chat/completions/', model: 'test-model', apiKey: null,
    })).status).toBe(200);
    mockUpstream('連線成功');
    const tested = await client.post('/api/ai/test', {});
    expect(tested.status).toBe(200);
    expect(await tested.json()).toMatchObject({ ok: true, reply: '連線成功' });
    expect(String(fetchSpy!.mock.calls[0]![0])).toBe('https://ai.example.com/v1/chat/completions');
  });

  it('分兩步驟：先存端點與模型，之後單獨勾選啟用要能持久化', async () => {
    expect((await client.post('/api/ai/settings', {
      baseUrl: 'https://ai.example.com/v1', model: 'test-model',
    })).status).toBe(200);
    const enableRes = await client.post('/api/ai/settings', {
      enabled: true, baseUrl: 'https://ai.example.com/v1', model: 'test-model',
    });
    expect(enableRes.status).toBe(200);
    expect(await enableRes.json()).toMatchObject({ enabled: true });
    const settings = await (await client.get('/api/ai/settings')).json();
    expect(settings).toMatchObject({ enabled: true });
  });

  it('併發：勾選啟用與另一個不含 enabled 的儲存同時送出，enabled 不能被舊值蓋掉', async () => {
    await client.post('/api/ai/settings', { baseUrl: 'https://race.example.com/v1', model: 'race-model' });
    const [a, b] = await Promise.all([
      client.post('/api/ai/settings', { enabled: true, baseUrl: 'https://race.example.com/v1', model: 'race-model' }),
      client.post('/api/ai/settings', { baseUrl: 'https://race.example.com/v1', model: 'race-model' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const settings = await (await client.get('/api/ai/settings')).json();
    expect(settings).toMatchObject({ enabled: true });
  });

  it('BYOK 設定：key 加密儲存、讀取永不回傳 key（AI-4）', async () => {
    const save = await client.post('/api/ai/settings', {
      enabled: true, baseUrl: 'https://ai.example.com/v1', model: 'test-model', apiKey: 'sk-secret-key-123',
    });
    expect(save.status).toBe(200);
    const settings = (await (await client.get('/api/ai/settings')).json()) as Record<string, unknown>;
    expect(settings['hasApiKey']).toBe(true);
    expect(JSON.stringify(settings)).not.toContain('sk-secret-key-123');
  });

  it('上游錯誤保留限長訊息，方便分辨 provider 500', async () => {
    expect((await client.post('/api/ai/settings', {
      enabled: true, baseUrl: 'https://ai.example.com/v1', model: 'test-model', apiKey: null,
    })).status).toBe(200);
    const upstreamMessage = `free provider unavailable: ${'x'.repeat(250)}`;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: { message: upstreamMessage } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const tested = await client.post('/api/ai/test', {});
    expect(tested.status).toBe(502);
    expect(await tested.json()).toMatchObject({
      error: { code: 'AI_UPSTREAM_FAILED', message: `AI 端點回應 500：${upstreamMessage.slice(0, 200)}` },
    });
  });

  it('上游 429 保留狀態與 Retry-After，不包成 502', async () => {
    expect((await client.post('/api/ai/settings', {
      enabled: true, baseUrl: 'https://ai.example.com/v1', model: 'test-model', apiKey: null,
    })).status).toBe(200);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '60' },
      }),
    );
    const tested = await client.post('/api/ai/test', {});
    expect(tested.status).toBe(429);
    expect(tested.headers.get('retry-after')).toBe('60');
    expect(await tested.json()).toMatchObject({
      error: {
        code: 'AI_RATE_LIMITED',
        message: 'AI 供應商已限制請求頻率：Rate limit exceeded，請在 60 秒後再試',
      },
    });
  });

  it('欄位抽取：AI 輸出逐行格式，走既有匯入管線成立審計（AI-2、AI-3）', async () => {
    expect((await client.post('/api/ai/settings', {
      enabled: true, baseUrl: 'https://ai.example.com/v1', model: 'test-model', apiKey: 'sk-test-key',
    })).status).toBe(200);
    mockUpstream(CLEANED_LINES);
    const sourceText = '2026/7/2 全家便利商 店ABC123 NT$120\n07-03 NETFLIX.COM 390元';
    const extract = await client.post('/api/ai/extract-statement', { text: sourceText });
    expect(extract.status).toBe(200);
    const { text } = (await extract.json()) as { text: string };
    expect(text).toBe(CLEANED_LINES);
    // 上游收到的是 OpenAI 相容 chat completions 請求，帶 Bearer key
    const [url, init] = fetchSpy!.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://ai.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>)['authorization']).toContain('Bearer ');

    // AI 產出的文字丟進既有匯入流程（AI 永不直接寫帳，仍走人工確認的審計）
    const imported = await client.post('/api/audit/import', {
      kind: 'text', text, sourceText, filename: 'ai-cleaned.txt', importerId: 'generic-text', creditCardAccountId: cardAccountId,
      defaults: { currency: 'TWD', periodStart: '2026-07-01', periodEnd: '2026-07-31', statementDate: '2026-07-31', dueDate: '2026-08-10', total: '510' },
    });
    expect(imported.status).toBe(201);
    const { sessionId } = (await imported.json()) as { sessionId: string };

    // 證據轉自然語言（解釋生成）：對 session 候選要得到 AI 白話解釋
    const detail = (await (await client.get(`/api/audit/sessions/${sessionId}`)).json()) as {
      file: { sha256: string };
      items: Array<{ raw: Record<string, unknown> }>;
      candidates: Array<{ id: string }>;
    };
    expect(detail.file.sha256).toBe(createHash('sha256').update(sourceText).digest('hex'));
    expect(detail.items[0]?.raw['inputOrigin']).toBe('ai_confirmed');
    expect(detail.candidates.length).toBeGreaterThan(0);
    mockUpstream('帳單上的全家 120 元在帳本裡找不到對應交易，可能是漏記。');
    const explain = await client.post('/api/ai/explain', { sessionId, candidateId: detail.candidates[0]!.id });
    expect(explain.status).toBe(200);
    expect(((await explain.json()) as { explanation: string }).explanation).toContain('全家');

    const hallucinatedId = uuidv7();
    mockUpstream(`\`\`\`json\n${JSON.stringify({
      summary: '先檢查帳本中找不到對應交易的項目，再確認整體差額。',
      candidateOrder: [hallucinatedId, detail.candidates[0]!.id],
    })}\n\`\`\``);
    const review = await client.post('/api/ai/review-session', { sessionId });
    expect(review.status).toBe(200);
    const reviewBody = (await review.json()) as { summary: string; candidateOrder: string[]; reviewedCount: number };
    expect(reviewBody.summary).toContain('先檢查');
    expect(reviewBody.candidateOrder).not.toContain(hallucinatedId);
    expect(reviewBody.candidateOrder).toHaveLength(reviewBody.reviewedCount);
  });
});
