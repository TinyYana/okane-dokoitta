import { randomBytes, createHash } from 'node:crypto';
import {
  applyMutation,
  cardCycleView,
  consumeDiscordLinkToken,
  createDiscordLinkToken,
  findDiscordLinkByDiscordUserId,
  findDiscordLinkByUserId,
  findUserById,
  getNotificationPreferences,
  listAccounts,
  listAuditSessions,
  listOpenExpected,
  listRecurringRules,
  listTransactions,
  netWorthSummary,
  newId,
  revokeDiscordLink,
  upsertDiscordLink,
  type Db,
} from '@okane-dokoitta/database';
import { civilDateFromInstant, formatCivilDate, parseAmount } from '@okane-dokoitta/domain';
import { formatAmountForPrivacy, type PrivacyMode } from '@okane-dokoitta/notifications';
import { MUTATION_PAYLOAD_SCHEMAS } from '@okane-dokoitta/schemas';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { checkCsrf, CSRF_HEADER, resolveSession, SESSION_COOKIE } from './auth.js';
import { suggestCategoryFromHistory } from './category-suggestion.js';
import { exchangeDiscordOAuthCode, fetchDiscordUser } from './discord-client.js';
import { verifyDiscordSignature } from './discord-verify.js';
import type { ApiEnv } from './env.js';

const LINK_TOKEN_TTL_MS = 10 * 60_000;
const SPENDABLE_SUBTYPES = new Set(['cash', 'bank', 'digital', 'e_wallet', 'brokerage_settlement', 'credit_card']);

interface LedgerAuth {
  userId: string;
  ledgerTimeZone: string;
  baseCurrency: string;
}

// ---------- Discord interaction 型別（只取用到的欄位，不引入 discord-api-types）----------

interface DiscordInteractionOption {
  name: string;
  value?: string | number | boolean;
  options?: DiscordInteractionOption[];
}

interface DiscordInteraction {
  type: 1 | 2 | 3; // PING / APPLICATION_COMMAND / MESSAGE_COMPONENT
  data?: { name?: string; options?: DiscordInteractionOption[]; custom_id?: string };
  member?: { user?: { id: string; username: string } };
  user?: { id: string; username: string };
}

function callerOf(interaction: DiscordInteraction): { id: string; username: string } | null {
  return interaction.member?.user ?? interaction.user ?? null;
}

function ephemeral(content: string, components?: unknown[]): Response {
  return Response.json({ type: 4, data: { content, flags: 64, ...(components ? { components } : {}) } });
}

function actionRow(buttons: Array<{ label: string; customId: string }>) {
  return [{ type: 1, components: buttons.map((b) => ({ type: 2, style: 2, label: b.label, custom_id: b.customId })) }];
}

/** 與 PWA 同一條路：Zod 驗證 payload → applyMutation（AGENTS §4，含冪等與 audit log）。 */
async function applyValidatedMutation(
  db: Db,
  user: { id: string; ledgerTimeZone: string },
  input: { entity: keyof typeof MUTATION_PAYLOAD_SCHEMAS; op: 'create' | 'update'; entityId: string; baseVersion: number | null; payload: Record<string, unknown> },
) {
  const schema = MUTATION_PAYLOAD_SCHEMAS[input.entity][input.op === 'create' ? 'create' : 'update'];
  if (!schema) {
    return { mutationId: '', result: 'rejected_invalid' as const, error: { code: 'OP_NOT_ALLOWED', message: `${input.entity} 不支援 ${input.op}` } };
  }
  const parsed = schema.safeParse(input.payload);
  if (!parsed.success) {
    return { mutationId: '', result: 'rejected_invalid' as const, error: { code: 'INVALID_PAYLOAD', message: parsed.error.issues[0]?.message ?? '格式錯誤' } };
  }
  return applyMutation(db, user, {
    mutationId: newId(),
    deviceId: 'discord-bot',
    entity: input.entity,
    entityId: input.entityId,
    op: input.op,
    baseVersion: input.baseVersion,
    payload: parsed.data as Record<string, unknown>,
    clientAt: new Date().toISOString(),
  });
}

export function discordRoutes(db: Db, env: ApiEnv): Hono {
  const app = new Hono();

  // ---- Discord → 我們（Ed25519 簽章驗證，ADR-005）----
  app.post('/interactions', async (c) => {
    if (!env.discord) return c.json({ error: { code: 'DISCORD_NOT_CONFIGURED', message: 'Discord 整合尚未設定' } }, 503);
    const signature = c.req.header('X-Signature-Ed25519');
    const timestamp = c.req.header('X-Signature-Timestamp');
    const rawBody = await c.req.text();
    if (!signature || !timestamp || !(await verifyDiscordSignature(env.discord.publicKey, signature, timestamp, rawBody))) {
      return c.body('invalid request signature', 401);
    }
    const interaction = JSON.parse(rawBody) as DiscordInteraction;
    if (interaction.type === 1) return c.json({ type: 1 }); // PING → PONG

    const caller = callerOf(interaction);
    if (!caller) return c.json({ type: 4, data: { content: '無法識別使用者身分', flags: 64 } });

    if (interaction.type === 3 && interaction.data?.custom_id) {
      return handleComponent(db, caller, interaction.data.custom_id);
    }
    if (interaction.type === 2 && interaction.data?.name === 'finance') {
      return handleFinanceCommand(db, env, caller, interaction.data.options ?? []);
    }
    return c.json({ type: 4, data: { content: '不支援的指令', flags: 64 } });
  });

  // ---- 帳號連結：直連（PWA「連結 Discord」按鈕觸發 OAuth）----
  app.post('/oauth/start', async (c) => {
    const auth = await resolveSession(db, env, getCookie(c, SESSION_COOKIE));
    if (!auth) return c.json({ error: { code: 'UNAUTHENTICATED', message: '請先登入' } }, 401);
    if (!checkCsrf(auth, c.req.header(CSRF_HEADER))) return c.json({ error: { code: 'CSRF_INVALID', message: 'CSRF token 無效' } }, 403);
    if (!env.discord) return c.json({ error: { code: 'DISCORD_NOT_CONFIGURED', message: 'Discord 整合尚未設定' } }, 503);
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', env.discord.appId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('redirect_uri', discordRedirectUri(env));
    url.searchParams.set('state', auth.csrfToken); // 綁定當前 session，callback 端再核對
    return c.json({ url: url.toString() });
  });

  app.get('/oauth/callback', async (c) => {
    const auth = await resolveSession(db, env, getCookie(c, SESSION_COOKIE));
    if (!auth) return c.redirect('/login');
    if (!env.discord) return c.redirect('/settings?discordError=not_configured');
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || state !== auth.csrfToken) return c.redirect('/settings?discordError=invalid_state');
    try {
      const token = await exchangeDiscordOAuthCode(
        { appId: env.discord.appId, clientSecret: env.discord.clientSecret, redirectUri: discordRedirectUri(env) },
        code,
      );
      const discordUser = await fetchDiscordUser(token.accessToken);
      await upsertDiscordLink(db, { id: newId(), userId: auth.userId, discordUserId: discordUser.id, discordUsername: discordUser.username });
      return c.redirect('/settings?discordLinked=1');
    } catch (err) {
      console.error(`[discord] oauth callback -> ${err instanceof Error ? err.constructor.name : 'UnknownError'}`);
      return c.redirect('/settings?discordError=link_failed');
    }
  });

  app.post('/revoke', async (c) => {
    const auth = await resolveSession(db, env, getCookie(c, SESSION_COOKIE));
    if (!auth) return c.json({ error: { code: 'UNAUTHENTICATED', message: '請先登入' } }, 401);
    if (!checkCsrf(auth, c.req.header(CSRF_HEADER))) return c.json({ error: { code: 'CSRF_INVALID', message: 'CSRF token 無效' } }, 403);
    await revokeDiscordLink(db, auth.userId);
    return c.json({ ok: true });
  });

  app.get('/status', async (c) => {
    const auth = await resolveSession(db, env, getCookie(c, SESSION_COOKIE));
    if (!auth) return c.json({ error: { code: 'UNAUTHENTICATED', message: '請先登入' } }, 401);
    const link = await findDiscordLinkByUserId(db, auth.userId);
    return c.json({ linked: link !== null, discordUsername: link?.discordUsername ?? null, enabled: env.discord !== null });
  });

  // ---- 反向連結：`/finance link` 產生的一次性 URL，登入中的瀏覽器打開即完成綁定 ----
  app.get('/link/consume', async (c) => {
    const auth = await resolveSession(db, env, getCookie(c, SESSION_COOKIE));
    if (!auth) return c.redirect(`/login?next=${encodeURIComponent(c.req.url)}`);
    const token = c.req.query('token');
    if (!token) return c.redirect('/settings?discordError=invalid_token');
    const consumed = await consumeDiscordLinkToken(db, hashLinkToken(env.sessionSecret, token));
    if (!consumed) return c.redirect('/settings?discordError=token_expired');
    await upsertDiscordLink(db, {
      id: newId(),
      userId: auth.userId,
      discordUserId: consumed.discordUserId,
      discordUsername: consumed.discordUsername,
    });
    return c.redirect('/settings?discordLinked=1');
  });

  return app;
}

function discordRedirectUri(env: ApiEnv): string {
  return `${env.baseUrl ?? `http://localhost:${env.port}`}/api/discord/oauth/callback`;
}

function hashLinkToken(secret: string, token: string): string {
  return createHash('sha256').update(`discord-link:${secret}:${token}`).digest('hex');
}

// ---------- Slash command 分派 ----------

async function handleFinanceCommand(
  db: Db,
  env: ApiEnv,
  caller: { id: string; username: string },
  options: DiscordInteractionOption[],
): Promise<Response> {
  const sub = options[0];
  if (!sub) return ephemeral('請指定子指令，例如 `/finance status`');

  const link = await findDiscordLinkByDiscordUserId(db, caller.id);
  if (!link) return unlinkedPrompt(db, env, caller);
  if (sub.name === 'link') return ephemeral('這個帳號已經連結囉，如需重新連結請先到 PWA 設定頁撤銷。');

  const user = await findUserById(db, link.userId);
  if (!user) return ephemeral('找不到對應的帳號，請重新連結。');
  const auth: LedgerAuth = { userId: link.userId, ledgerTimeZone: user.ledgerTimeZone, baseCurrency: user.baseCurrency };
  const prefs = await getNotificationPreferences(db, link.userId);

  const args = Object.fromEntries((sub.options ?? []).map((o) => [o.name, o.value]));
  switch (sub.name) {
    case 'status':
      return commandStatus(db, auth, prefs.privacyMode);
    case 'networth':
      return commandNetworth(db, auth, prefs.privacyMode);
    case 'upcoming':
      return commandUpcoming(db, auth, prefs.privacyMode);
    case 'cards':
      return commandCards(db, auth, prefs.privacyMode);
    case 'pending':
      return commandPending(db, auth);
    case 'audit-status':
      return commandAuditStatus(db, auth);
    case 'reminders':
      return ephemeral(remindersSummary(prefs));
    case 'add':
      return commandAdd(db, auth, String(args['amount'] ?? ''), String(args['note'] ?? ''));
    case 'confirm':
      return commandConfirmList(db, auth, prefs.privacyMode);
    default:
      return ephemeral('不支援的子指令');
  }
}

async function unlinkedPrompt(db: Db, env: ApiEnv, caller: { id: string; username: string }): Promise<Response> {
  const token = randomBytes(24).toString('base64url');
  await createDiscordLinkToken(db, {
    id: newId(),
    tokenHash: hashLinkToken(env.sessionSecret, token),
    discordUserId: caller.id,
    discordUsername: caller.username,
    expiresAt: new Date(Date.now() + LINK_TOKEN_TTL_MS),
  });
  const base = env.baseUrl ?? `http://localhost:${env.port}`;
  const url = `${base}/api/discord/link/consume?token=${token}`;
  return ephemeral(`這個 Discord 帳號還沒連結。請在已登入的 PWA 分頁打開這個連結完成綁定（10 分鐘內有效）：\n${url}`);
}

// ---------- 讀取指令 ----------

async function commandStatus(db: Db, auth: LedgerAuth, privacy: PrivacyMode): Promise<Response> {
  const today = civilDateFromInstant(new Date().toISOString(), auth.ledgerTimeZone);
  const [summary, expected] = await Promise.all([netWorthSummary(db, auth.userId, auth.baseCurrency, today), listOpenExpected(db, auth.userId)]);
  const overdue = expected.filter((e) => e.expectedDate < formatCivilDate(today)).length;
  const lines = [
    `淨資產：${formatAmountForPrivacy(summary.netWorthMinor, auth.baseCurrency, privacy)}${summary.incomplete ? '（部分資料待補）' : ''}`,
    `未來 30 天預計支出：${formatAmountForPrivacy(summary.upcomingOutflow30dMinor, auth.baseCurrency, privacy)}`,
    overdue > 0 ? `⚠️ ${overdue} 筆預計交易逾期未確認` : '沒有逾期未確認的預計交易 ✅',
  ];
  return ephemeral(lines.join('\n'));
}

async function commandNetworth(db: Db, auth: LedgerAuth, privacy: PrivacyMode): Promise<Response> {
  const today = civilDateFromInstant(new Date().toISOString(), auth.ledgerTimeZone);
  const summary = await netWorthSummary(db, auth.userId, auth.baseCurrency, today);
  const freshness = summary.oldestDataAsOf ? `（最舊資料：${new Date(summary.oldestDataAsOf).toISOString().slice(0, 10)}）` : '';
  return ephemeral(
    `💰 淨資產：${formatAmountForPrivacy(summary.netWorthMinor, auth.baseCurrency, privacy)}${summary.incomplete ? '（部分帳戶缺匯率/報價，數字可能不完整）' : ''}${freshness}\n` +
      `現金：${formatAmountForPrivacy(summary.cashMinor, auth.baseCurrency, privacy)}｜投資：${formatAmountForPrivacy(summary.investmentsMinor, auth.baseCurrency, privacy)}｜負債：${formatAmountForPrivacy(summary.liabilitiesMinor, auth.baseCurrency, privacy)}`,
  );
}

async function commandUpcoming(db: Db, auth: LedgerAuth, privacy: PrivacyMode): Promise<Response> {
  const today = formatCivilDate(civilDateFromInstant(new Date().toISOString(), auth.ledgerTimeZone));
  const horizon = addDaysToDateString(today, 14);
  const expected = (await listOpenExpected(db, auth.userId)).filter((e) => e.expectedDate <= horizon);
  if (expected.length === 0) return ephemeral('未來 14 天沒有預計扣款/繳款 ✅');
  const lines = expected
    .slice(0, 10)
    .map((e) => `${e.expectedDate}｜${e.amountMinor !== null ? formatAmountForPrivacy(e.amountMinor, e.currency, privacy) : '浮動金額'}`);
  return ephemeral(`📅 未來 14 天：\n${lines.join('\n')}`);
}

async function commandCards(db: Db, auth: LedgerAuth, privacy: PrivacyMode): Promise<Response> {
  const today = civilDateFromInstant(new Date().toISOString(), auth.ledgerTimeZone);
  const accounts = (await listAccounts(db, auth.userId)).filter((a) => a.subtype === 'credit_card');
  if (accounts.length === 0) return ephemeral('還沒有登記信用卡');
  const lines: string[] = [];
  for (const account of accounts) {
    const view = await cardCycleView(db, auth.userId, account.id, today);
    if (!view) continue;
    const currentTotal = view.current.postedMinor + view.current.pendingMinor - view.current.refundedMinor;
    lines.push(
      `💳 ${account.name}：本期至今 ${formatAmountForPrivacy(currentTotal, view.currency, privacy)}（${view.current.statementDate} 結帳）｜上期未繳 ${formatAmountForPrivacy(view.previous.unpaidMinor, view.currency, privacy)}（${view.previous.dueDate} 到期）`,
    );
  }
  return ephemeral(lines.join('\n') || '找不到卡片資料');
}

async function commandPending(db: Db, auth: LedgerAuth): Promise<Response> {
  const [txns, expected] = await Promise.all([listTransactions(db, auth.userId, { limit: 200 }), listOpenExpected(db, auth.userId)]);
  const needsReview = txns.filter((t) => t.needsReview);
  const lines = [
    needsReview.length > 0 ? `📝 ${needsReview.length} 筆待審交易` : '沒有待審交易 ✅',
    expected.length > 0 ? `📅 ${expected.length} 筆未確認的預計交易` : '沒有未確認的預計交易 ✅',
  ];
  return ephemeral(lines.join('\n'));
}

async function commandAuditStatus(db: Db, auth: LedgerAuth): Promise<Response> {
  const sessions = await listAuditSessions(db, auth.userId);
  const latest = sessions[0];
  if (!latest) return ephemeral('還沒有審計紀錄');
  const stats = latest.session.stats as { discrepancyCount?: number; matchedCount?: number };
  return ephemeral(
    `🔍 最近一次審計（${latest.statement.statementDate}）：${latest.session.status}\n` +
      `配對 ${stats.matchedCount ?? 0} 筆｜差異 ${stats.discrepancyCount ?? 0} 筆`,
  );
}

function remindersSummary(prefs: { privacyMode: string; discordEnabled: boolean; webPushEnabled: boolean; mutedEventTypes: string[] }): string {
  const lines = [
    `隱私模式：${prefs.privacyMode}`,
    `Discord 通知：${prefs.discordEnabled ? '開啟' : '關閉'}｜Web Push：${prefs.webPushEnabled ? '開啟' : '關閉'}`,
    prefs.mutedEventTypes.length > 0 ? `已靜音：${prefs.mutedEventTypes.join('、')}` : '沒有靜音任何事件類型',
    '完整設定請到 PWA 設定頁調整。',
  ];
  return lines.join('\n');
}

// ---------- 寫入指令：/finance add（草稿）----------

async function commandAdd(db: Db, auth: LedgerAuth, amountText: string, note: string): Promise<Response> {
  const amountMinor = parsePositiveAmount(amountText, auth.baseCurrency);
  if (amountMinor === null) return ephemeral('金額格式不對，請輸入正數，例如 `/finance add 120 午餐`');
  const draft = await inferDraftAccounts(db, auth.userId, note);
  if (!draft) return ephemeral('找不到可用的帳戶或分類，請先到 PWA 設定基本帳戶。');

  const outcome = await applyValidatedMutation(db, { id: auth.userId, ledgerTimeZone: auth.ledgerTimeZone }, {
    entity: 'transactions',
    op: 'create',
    entityId: newId(),
    baseVersion: null,
    payload: {
      type: 'expense',
      status: 'draft',
      amountMinor: amountMinor.toString(),
      currency: auth.baseCurrency,
      fromAccountId: draft.fromAccountId,
      categoryAccountId: draft.categoryAccountId,
      merchantRaw: note || null,
      occurredAt: new Date().toISOString(),
      source: 'discord_draft',
      needsReview: true,
    },
  });
  if (outcome.result !== 'applied' && outcome.result !== 'duplicate') {
    return ephemeral(`建立草稿失敗：${outcome.error?.message ?? '未知錯誤'}`);
  }
  return ephemeral(
    `📝 草稿已建立：${formatAmountForPrivacy(amountMinor, auth.baseCurrency, 'full')}${note ? ` · ${note}` : ''}\n` +
      `已暫記到「${draft.categoryLabel}」，請到 PWA 確認帳戶/分類後才會正式入帳。`,
  );
}

async function inferDraftAccounts(
  db: Db,
  userId: string,
  merchant: string,
): Promise<{ fromAccountId: string; categoryAccountId: string; categoryLabel: string } | null> {
  const [accounts, history] = await Promise.all([listAccounts(db, userId), listTransactions(db, userId, { limit: 100 })]);
  const spendable = accounts.filter((a) => SPENDABLE_SUBTYPES.has(a.subtype));
  const categories = accounts.filter((a) => a.subtype === 'category_expense');
  if (spendable.length === 0 || categories.length === 0) return null;

  const recentExpense = history.find((t) => t.type === 'expense' && t.fromAccountId);
  const fromAccountId = recentExpense?.fromAccountId ?? spendable[0]!.id;

  const suggestion = merchant ? suggestCategoryFromHistory(history, merchant, 'expense') : null;
  const categoryAccountId =
    suggestion?.categoryAccountId ??
    history.find((t) => t.type === 'expense' && t.categoryAccountId)?.categoryAccountId ??
    categories.find((c) => c.name === '其他支出')?.id ??
    categories[0]!.id;
  const categoryLabel = accounts.find((a) => a.id === categoryAccountId)?.name ?? '未分類';
  return { fromAccountId, categoryAccountId, categoryLabel };
}

function parsePositiveAmount(text: string, currency: string): bigint | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  try {
    const minor = parseAmount(trimmed, currency);
    return minor > 0n ? minor : null;
  } catch {
    return null;
  }
}

// ---------- 寫入指令：/finance confirm（按鈕二次確認）----------

async function commandConfirmList(db: Db, auth: LedgerAuth, privacy: PrivacyMode): Promise<Response> {
  const expected = await listOpenExpected(db, auth.userId);
  if (expected.length === 0) return ephemeral('沒有待確認的預計交易 ✅');
  const rules = await listRecurringRules(db, auth.userId);
  const rows = expected.slice(0, 5).map((e) => {
    const rule = rules.find((r) => r.id === e.ruleId);
    const label = `${e.expectedDate} ${rule?.name ?? '未命名'} ${e.amountMinor !== null ? formatAmountForPrivacy(e.amountMinor, e.currency, privacy) : ''}`;
    return { label: label.slice(0, 80), customId: `confirm:${e.id}` };
  });
  return ephemeral('待確認的預計交易（點按鈕確認入帳）：', actionRow(rows));
}

async function handleComponent(db: Db, caller: { id: string; username: string }, customId: string): Promise<Response> {
  const [action, expectedId] = customId.split(':');
  if (action !== 'confirm' || !expectedId) return ephemeral('不支援的操作');
  const link = await findDiscordLinkByDiscordUserId(db, caller.id);
  if (!link) return ephemeral('請先連結帳號');

  const user = await findUserById(db, link.userId);
  if (!user) return ephemeral('找不到帳號資料');
  const expected = (await listOpenExpected(db, link.userId)).find((e) => e.id === expectedId);
  if (!expected) return ephemeral('這筆預計交易已經處理過了');
  const rules = await listRecurringRules(db, link.userId);
  const rule = rules.find((r) => r.id === expected.ruleId);
  if (!rule?.categoryAccountId || expected.amountMinor === null) {
    return ephemeral('浮動金額或未設分類的規則，請到 PWA 手動記帳後略過這筆。');
  }

  const txnId = newId();
  const createOutcome = await applyValidatedMutation(db, { id: link.userId, ledgerTimeZone: user.ledgerTimeZone }, {
    entity: 'transactions',
    op: 'create',
    entityId: txnId,
    baseVersion: null,
    payload: {
      type: 'expense',
      amountMinor: expected.amountMinor.toString(),
      currency: expected.currency,
      fromAccountId: expected.accountId,
      categoryAccountId: rule.categoryAccountId,
      merchantRaw: rule.merchantHint ?? rule.name,
      occurredAt: new Date().toISOString(),
      expectedTransactionId: expected.id,
      recurringRuleId: rule.id,
      source: 'recurring',
    },
  });
  if (createOutcome.result !== 'applied' && createOutcome.result !== 'duplicate') {
    return ephemeral(`確認失敗：${createOutcome.error?.message ?? '未知錯誤'}`);
  }
  const updateOutcome = await applyValidatedMutation(db, { id: link.userId, ledgerTimeZone: user.ledgerTimeZone }, {
    entity: 'expected_transactions',
    op: 'update',
    entityId: expected.id,
    baseVersion: expected.version,
    payload: { status: 'confirmed', matchedTransactionId: txnId },
  });
  if (updateOutcome.result !== 'applied' && updateOutcome.result !== 'duplicate') {
    return ephemeral(`已記帳，但更新預計交易狀態失敗：${updateOutcome.error?.message ?? '未知錯誤'}`);
  }
  return ephemeral(`已確認並記帳 ✓ ${rule.name}`);
}

function addDaysToDateString(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
