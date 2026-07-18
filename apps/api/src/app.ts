import {
  civilDateFromInstant,
  DomainError,
  knownCurrencies,
  parseCivilDate,
} from '@okane-dokoitta/domain';
import {
  applyMutation,
  cardCycleView,
  exportAllData,
  listAccountGroups,
  listAccounts,
  listHoldings,
  listInvestmentAccounts,
  listLimitGroups,
  listOpenExpected,
  listRecurringRules,
  listSecurities,
  listTransactions,
  netWorthSummary,
  deviceIsActive,
  registerDevice,
  restoreAllData,
  RestoreError,
  toJsonSafe,
  updateUserBaseCurrency,
  type Db,
  type MutationOutcome,
} from '@okane-dokoitta/database';
import { v7 as uuidv7 } from 'uuid';
import { EXPORT_FORMAT_VERSION, MUTATION_PAYLOAD_SCHEMAS, zCurrency, zMutationEnvelope } from '@okane-dokoitta/schemas';
import { zipSync, strToU8 } from 'fflate';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { authRoutes, checkCsrf, CSRF_HEADER, resolveSession, SESSION_COOKIE, type AuthContext } from './auth.js';
import type { ApiEnv } from './env.js';
import { clientIp, originCheck, rateLimit, securityHeaders } from './security.js';
import { syncRoutes } from './sync-routes.js';
import { accountRoutes } from './account-routes.js';
import { passkeyRoutes } from './passkey-routes.js';
import { auditRoutes } from './audit-routes.js';
import { discordRoutes } from './discord-routes.js';
import { notificationsRoutes } from './notifications-routes.js';
import { aiRoutes } from './ai-routes.js';
import { investmentRoutes } from './investment-routes.js';
import { suggestCategoryFromHistory } from './category-suggestion.js';

type Variables = { auth: AuthContext };

/** 組出完整 API app（server.ts 與 L3 測試共用）。 */
export function createApp(db: Db, env: ApiEnv): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', securityHeaders);
  app.use(
    '*',
    rateLimit({ windowMs: 60_000, max: 600, keyFn: (c) => `global:${clientIp(c)}` }),
  );
  app.use(
    '/api/*',
    originCheck(() => {
      const origins = ['http://localhost:5173', `http://localhost:${env.port}`];
      if (env.baseUrl) origins.push(new URL(env.baseUrl).origin);
      return origins;
    }),
  );
  app.route(
    '/api/auth',
    new Hono()
      .use('*', rateLimit({ windowMs: 60_000, max: 10, keyFn: (c) => `auth:${clientIp(c)}` }))
      .route('/', authRoutes(db, env)),
  );
  app.route(
    '/api/auth',
    new Hono().use('*', rateLimit({ windowMs: 60_000, max: 20, keyFn: (c) => `passkey:${clientIp(c)}` })).route('/', passkeyRoutes(db, env)),
  );
  app.route(
    '/api/discord',
    new Hono().use('*', rateLimit({ windowMs: 60_000, max: 120, keyFn: (c) => `discord:${clientIp(c)}` })).route('/', discordRoutes(db, env)),
  );

  // ---- 以下全部需要登入 + CSRF（state-changing）----
  const authed = new Hono<{ Variables: Variables }>();
  authed.use('*', async (c, next) => {
    const auth = await resolveSession(db, env, getCookie(c, SESSION_COOKIE));
    if (!auth) return c.json({ error: { code: 'UNAUTHENTICATED', message: '請先登入' } }, 401);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (!checkCsrf(auth, c.req.header(CSRF_HEADER))) {
        return c.json({ error: { code: 'CSRF_INVALID', message: 'CSRF token 無效' } }, 403);
      }
    }
    c.set('auth', auth);
    await next();
  });

  authed.get('/me', (c) => {
    const auth = c.get('auth');
    return c.json({
      userId: auth.userId,
      email: auth.email,
      displayName: auth.displayName,
      ledgerTimeZone: auth.ledgerTimeZone,
      baseCurrency: auth.baseCurrency,
      csrfToken: auth.csrfToken,
      isAdmin: auth.isAdmin,
    });
  });

  /** 淨資產一覽的換算基準幣別（M4）：非同步 mutation 實體，直接更新。 */
  authed.post('/me/base-currency', async (c) => {
    const auth = c.get('auth');
    const parsed = zCurrency.safeParse((await c.req.json().catch(() => ({})) as { currency?: unknown }).currency);
    if (!parsed.success) return c.json({ error: { code: 'INVALID_INPUT', message: '幣別格式錯誤' } }, 422);
    if (!knownCurrencies().some((cur) => cur.code === parsed.data)) {
      return c.json({ error: { code: 'CURRENCY_UNKNOWN', message: `未知幣別: ${parsed.data}` } }, 422);
    }
    await updateUserBaseCurrency(db, auth.userId, parsed.data);
    return c.json({ baseCurrency: parsed.data });
  });

  authed.get('/meta', (c) => {
    return c.json({ currencies: knownCurrencies(), exportFormatVersion: EXPORT_FORMAT_VERSION });
  });

  // ---- 寫入唯一入口：冪等 mutation（SYNC_DESIGN §3）----
  authed.post(
    '/mutations',
    rateLimit({ windowMs: 60_000, max: 240, keyFn: (c) => `mut:${(c as never as { get: (k: string) => AuthContext }).get('auth')?.userId ?? clientIp(c)}` }),
    async (c) => {
      const auth = c.get('auth');
      const body = await c.req.json().catch(() => null);
      const envelope = zMutationEnvelope.safeParse(body);
      if (!envelope.success) {
        return c.json(
          { error: { code: 'INVALID_ENVELOPE', message: envelope.error.issues[0]?.message ?? 'envelope 格式錯誤' } },
          422,
        );
      }
      const { entity, op } = envelope.data;
      if (!(await deviceIsActive(db, auth.userId, envelope.data.deviceId))) {
        try {
          await registerDevice(db, { id: envelope.data.deviceId, userId: auth.userId, name: 'Web 裝置', platform: 'web' });
        } catch {
          return c.json({ error: { code: 'DEVICE_REVOKED', message: '此裝置已撤銷，請重新登入' } }, 403);
        }
      }
      // schema 層拒絕也回 rejected_invalid 信封（與 domain 拒絕一致）：這是確定性拒絕，
      // 重送永遠不會過——回裸 {error} 會讓 client 的 outbox 永遠卡住重試、堵住後面的變更
      const rejectInvalid = (code: string, message: string) =>
        c.json({ mutationId: envelope.data.mutationId, result: 'rejected_invalid', error: { code, message } }, 422);
      let payload: Record<string, unknown> = {};
      if (op !== 'delete') {
        const schemaFor = MUTATION_PAYLOAD_SCHEMAS[entity][op === 'create' ? 'create' : 'update'];
        if (!schemaFor) {
          return rejectInvalid('OP_NOT_ALLOWED', `${entity} 不支援 ${op}`);
        }
        const parsed = schemaFor.safeParse(envelope.data.payload);
        if (!parsed.success) {
          return rejectInvalid('INVALID_PAYLOAD', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        }
        payload = parsed.data as Record<string, unknown>;
      }
      const outcome = await applyMutation(
        db,
        { id: auth.userId, ledgerTimeZone: auth.ledgerTimeZone },
        {
          mutationId: envelope.data.mutationId,
          deviceId: envelope.data.deviceId,
          entity,
          entityId: envelope.data.entityId,
          op,
          baseVersion: envelope.data.baseVersion,
          payload,
          clientAt: envelope.data.clientAt,
        },
      );
      return c.json(toJsonSafe(outcome) as Record<string, unknown>, statusFor(outcome));
    },
  );

  // ---- 讀取 ----
  authed.get('/accounts', async (c) => {
    const auth = c.get('auth');
    const [accounts, groups, limitGroups] = await Promise.all([
      listAccounts(db, auth.userId),
      listAccountGroups(db, auth.userId),
      listLimitGroups(db, auth.userId),
    ]);
    return c.json(toJsonSafe({ accounts, groups, limitGroups }) as Record<string, unknown>);
  });

  authed.get('/transactions', async (c) => {
    const auth = c.get('auth');
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    const rows = await listTransactions(db, auth.userId, {
      limit,
      before: c.req.query('before'),
      accountId: c.req.query('accountId'),
    });
    return c.json(toJsonSafe({ transactions: rows }) as Record<string, unknown>);
  });

  authed.get('/category-suggestion', async (c) => {
    const auth = c.get('auth');
    const merchant = c.req.query('merchant')?.trim() ?? '';
    const type = c.req.query('type');
    if (!merchant || merchant.length > 120 || (type !== 'expense' && type !== 'income')) {
      return c.json({ error: { code: 'INVALID_QUERY', message: '商家或交易類型不正確' } }, 422);
    }
    const history = await listTransactions(db, auth.userId, { limit: 200 });
    return c.json({ suggestion: suggestCategoryFromHistory(history, merchant, type) });
  });

  authed.get('/cards/:accountId/cycle', async (c) => {
    const auth = c.get('auth');
    const todayParam = c.req.query('today');
    const today = todayParam
      ? parseCivilDate(todayParam)
      : civilDateFromInstant(new Date().toISOString(), auth.ledgerTimeZone);
    const view = await cardCycleView(db, auth.userId, c.req.param('accountId'), today);
    if (!view) return c.json({ error: { code: 'NOT_FOUND', message: '找不到這張卡' } }, 404);
    return c.json(toJsonSafe(view) as Record<string, unknown>);
  });

  authed.get('/recurring', async (c) => {
    const auth = c.get('auth');
    const [rules, expected] = await Promise.all([
      listRecurringRules(db, auth.userId),
      listOpenExpected(db, auth.userId),
    ]);
    return c.json(toJsonSafe({ rules, expected }) as Record<string, unknown>);
  });

  authed.get('/investments', async (c) => {
    const auth = c.get('auth');
    const [investmentAccounts, securities, holdings] = await Promise.all([
      listInvestmentAccounts(db, auth.userId),
      listSecurities(db, auth.userId),
      listHoldings(db, auth.userId),
    ]);
    return c.json(toJsonSafe({ investmentAccounts, securities, holdings }) as Record<string, unknown>);
  });

  authed.get('/net-worth', async (c) => {
    const auth = c.get('auth');
    const todayParam = c.req.query('today');
    const today = todayParam
      ? parseCivilDate(todayParam)
      : civilDateFromInstant(new Date().toISOString(), auth.ledgerTimeZone);
    const summary = await netWorthSummary(db, auth.userId, auth.baseCurrency, today);
    return c.json(toJsonSafe(summary) as Record<string, unknown>);
  });

  authed.route('/sync', syncRoutes(db));
  authed.route('/account', accountRoutes(db, env));
  authed.route('/audit', auditRoutes(db, env));
  authed.route('/notifications', notificationsRoutes(db, env));
  authed.route('/ai', aiRoutes(db, env));
  authed.route('/investments', investmentRoutes(db, env));

  // ---- 匯入完整備份（資料所有權：帶得走也帶得回來）----
  authed.post('/import/json', async (c) => {
    const auth = c.get('auth');
    const body = await c.req
      .json<{ formatVersion?: unknown; data?: unknown }>()
      .catch(() => null);
    if (
      !body ||
      body.formatVersion !== EXPORT_FORMAT_VERSION ||
      typeof body.data !== 'object' ||
      body.data === null ||
      Array.isArray(body.data)
    ) {
      return c.json({ error: { code: 'INVALID_IMPORT_FILE', message: '這不是有效的完整 JSON 備份檔' } }, 422);
    }
    try {
      const summary = await restoreAllData(db, auth.userId, body.data as Record<string, unknown>, uuidv7());
      return c.json(toJsonSafe(summary) as Record<string, unknown>);
    } catch (error) {
      if (error instanceof RestoreError) {
        return c.json({ error: { code: error.code, message: error.message } }, error.code === 'LEDGER_NOT_EMPTY' ? 409 : 422);
      }
      throw error;
    }
  });

  // ---- 完整匯出（SYNC-8 M1；資料所有權）----
  authed.get('/export/json', async (c) => {
    const auth = c.get('auth');
    const data = await exportAllData(db, auth.userId);
    const body = {
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      user: { id: auth.userId, email: auth.email, displayName: auth.displayName, ledgerTimeZone: auth.ledgerTimeZone },
      data: toJsonSafe(data),
    };
    c.header('Content-Disposition', `attachment; filename="okane-dokoitta-export-${Date.now()}.json"`);
    return c.json(body);
  });

  authed.get('/export/csv', async (c) => {
    const auth = c.get('auth');
    const data = await exportAllData(db, auth.userId);
    const files: Record<string, Uint8Array> = {};
    for (const [entity, rows] of Object.entries(data)) {
      files[`${entity}.csv`] = strToU8(toCsv(toJsonSafe(rows) as Record<string, unknown>[]));
    }
    const zip = zipSync(files);
    c.header('Content-Type', 'application/zip');
    c.header('Content-Disposition', `attachment; filename="okane-dokoitta-export-${Date.now()}.zip"`);
    return c.body(zip.slice().buffer as ArrayBuffer);
  });

  app.route('/api', authed);

  app.onError((err, c) => {
    if (err instanceof DomainError) {
      return c.json({ error: { code: err.code, message: err.message } }, 422);
    }
    // log redaction：只記錯誤類別與路徑，不記 body/金額/token（SECURITY §5）
    console.error(`[api] ${c.req.method} ${c.req.path} -> ${err.name}: ${err.constructor.name}`);
    return c.json({ error: { code: 'INTERNAL', message: '伺服器錯誤' } }, 500);
  });

  return app;
}

function statusFor(outcome: MutationOutcome): 200 | 409 | 422 {
  switch (outcome.result) {
    case 'applied':
    case 'duplicate':
      return 200;
    case 'rejected_conflict':
      return 409;
    case 'rejected_invalid':
      return 422;
  }
}

/** CSV：RFC4180 引號跳脫 + 公式注入防護（=+-@ 開頭加 '） */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const escape = (value: unknown): string => {
    let s = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    if (/[",\n\r]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
    return s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\r\n');
}
