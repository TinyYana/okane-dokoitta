import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  countUsers,
  createAuthChallenge,
  createFirstUserWithDefaults,
  createSession,
  createUserFromInvite,
  createUserWithDefaults,
  findActiveSession,
  findUserByEmail,
  getPasswordCredential,
  getTotpCredential,
  revokeSession,
  touchSession,
  type Db,
} from '@okane-dokoitta/database';
import { zLoginRequest, zRegisterRequest, zSetupRequest } from '@okane-dokoitta/schemas';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ApiEnv } from './env.js';
import { v7 as uuidv7 } from 'uuid';

export const SESSION_COOKIE = 'odk_session';
const SESSION_ABSOLUTE_DAYS = 30;
const SESSION_IDLE_DAYS = 7;
export const CSRF_HEADER = 'x-odk-csrf';

export interface AuthContext {
  userId: string;
  email: string;
  displayName: string | null;
  ledgerTimeZone: string;
  baseCurrency: string;
  csrfToken: string;
  tokenHash: string;
  isAdmin: boolean;
}

/** session token 只以 HMAC(secret) 雜湊落庫；cookie 才有原始值 */
export function hashSessionToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

export async function resolveSession(db: Db, env: ApiEnv, cookieToken: string | undefined): Promise<AuthContext | null> {
  if (!cookieToken) return null;
  const tokenHash = hashSessionToken(env.sessionSecret, cookieToken);
  const row = await findActiveSession(db, tokenHash);
  if (!row) return null;
  const idleLimit = Date.now() - SESSION_IDLE_DAYS * 86400_000;
  if (row.session.lastSeenAt.getTime() < idleLimit) return null; // 閒置過期
  // 節流更新 last_seen（>5 分鐘才寫）
  if (Date.now() - row.session.lastSeenAt.getTime() > 5 * 60_000) {
    await touchSession(db, tokenHash);
  }
  return {
    userId: row.user.id,
    email: row.user.email,
    displayName: row.user.displayName,
    ledgerTimeZone: row.user.ledgerTimeZone,
    baseCurrency: row.user.baseCurrency,
    csrfToken: row.session.csrfToken,
    tokenHash,
    isAdmin: row.user.isAdmin,
  };
}

export function checkCsrf(auth: AuthContext, headerValue: string | undefined): boolean {
  if (!headerValue) return false;
  const a = Buffer.from(auth.csrfToken);
  const b = Buffer.from(headerValue);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isSecureDeployment(env: ApiEnv): boolean {
  return env.baseUrl !== null && env.baseUrl.startsWith('https://');
}

// 密碼雜湊：PBKDF2-HMAC-SHA256 走 Web Crypto（Workers 原生）。argon2/hash-wasm 在 Workers 上
// 會因 runtime WASM 編譯被禁而拋 CompileError，無法用。格式自述以便日後調參數：
//   pbkdf2$sha256$<iterations>$<salt base64url>$<derivedKey base64url>
// Cloudflare Workers 對單次 PBKDF2 迭代數硬性上限 100000（超過丟 NotSupportedError），
// 且免費方案每請求只有 10ms CPU —— 100000 是這平台實際能用的上限。低於 OWASP 2023 的
// 600k，但主要登入是 Passkey、密碼只是備援，加上 16 byte 隨機 salt，對自架個人站可接受。
// iters 存在雜湊字串裡，付費方案想調高可再用分段疊代（每段 ≤100000）。
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 32;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, PBKDF2_KEYLEN * 8);
  return new Uint8Array(bits);
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${salt.toString('base64url')}$${Buffer.from(dk).toString('base64url')}`;
}

async function verifyPassword(hash: string, password: string): Promise<boolean> {
  const [scheme, algo, iters, saltB64, dkB64] = hash.split('$');
  if (scheme !== 'pbkdf2' || algo !== 'sha256' || !iters || !saltB64 || !dkB64) return false;
  const iterations = Number(iters);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const expected = Buffer.from(dkB64, 'base64url');
  const actual = Buffer.from(await pbkdf2(password, Buffer.from(saltB64, 'base64url'), iterations));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

let dummyHashCache: string | null = null;
async function dummyHash(): Promise<string> {
  dummyHashCache ??= await hashPassword('dummy-password-for-timing');
  return dummyHashCache;
}

export async function issueSession(db: Db, env: ApiEnv, userId: string): Promise<{ token: string; csrfToken: string }> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  await createSession(db, {
    tokenHash: hashSessionToken(env.sessionSecret, token),
    publicId: uuidv7(),
    userId,
    csrfToken,
    expiresAt: new Date(Date.now() + SESSION_ABSOLUTE_DAYS * 86400_000),
  });
  return { token, csrfToken };
}

export function setSessionCookie(c: Context, env: ApiEnv, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureDeployment(env),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_ABSOLUTE_DAYS * 86400,
  });
}

export function authRoutes(db: Db, env: ApiEnv): Hono {
  const app = new Hono();

  app.get('/status', async (c) => {
    const users = await countUsers(db);
    const auth = await resolveSession(db, env, getCookie(c, SESSION_COOKIE));
    return c.json({ needsSetup: users === 0, authenticated: auth !== null, registrationMode: env.registrationMode });
  });

  // first-run setup：只有 0 個使用者時可用（M1 單使用者；M2 正式註冊）
  app.post('/setup', async (c) => {
    if ((await countUsers(db)) > 0) {
      return c.json({ error: { code: 'ALREADY_SETUP', message: '已完成初始設定' } }, 409);
    }
    const parsed = zSetupRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message ?? '輸入格式錯誤' } }, 422);
    }
    const passwordHash = await hashPassword(parsed.data.password);
    const result = await createFirstUserWithDefaults(db, {
      email: parsed.data.email,
      displayName: parsed.data.displayName ?? null,
      passwordHash,
      ledgerTimeZone: env.ledgerTimeZone,
      isAdmin: true,
    });
    if (!result) return c.json({ error: { code: 'ALREADY_SETUP', message: '已完成初始設定' } }, 409);
    const { userId } = result;
    const { token, csrfToken } = await issueSession(db, env, userId);
    setSessionCookie(c, env, token);
    return c.json({ userId, csrfToken });
  });

  app.post('/register', async (c) => {
    if (env.registrationMode === 'closed') {
      return c.json({ error: { code: 'REGISTRATION_CLOSED', message: '此實例未開放註冊' } }, 403);
    }
    const parsed = zRegisterRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message ?? '輸入格式錯誤' } }, 422);
    }
    const passwordHash = await hashPassword(parsed.data.password);
    const input = {
      email: parsed.data.email,
      displayName: parsed.data.displayName ?? null,
      passwordHash,
      ledgerTimeZone: env.ledgerTimeZone,
    };
    try {
      const result =
        env.registrationMode === 'invite'
          ? parsed.data.inviteCode
            ? await createUserFromInvite(db, hashInviteCode(env.sessionSecret, parsed.data.inviteCode), input)
            : null
          : await createUserWithDefaults(db, input);
      if (!result) return c.json({ error: { code: 'INVITE_INVALID', message: '邀請碼無效或已使用' } }, 403);
      const { token, csrfToken } = await issueSession(db, env, result.userId);
      setSessionCookie(c, env, token);
      return c.json({ userId: result.userId, csrfToken });
    } catch (err) {
      if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
        return c.json({ error: { code: 'EMAIL_EXISTS', message: '此 Email 已註冊' } }, 409);
      }
      throw err;
    }
  });

  app.post('/login', async (c) => {
    const parsed = zLoginRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: 'INVALID_INPUT', message: '輸入格式錯誤' } }, 422);
    }
    const user = await findUserByEmail(db, parsed.data.email);
    const cred = user ? await getPasswordCredential(db, user.id) : null;
    // 帳號不存在也跑一次 verify，避免 timing 差異洩漏帳號存在性
    let ok = false;
    if (cred?.passwordHash) {
      ok = await verifyPassword(cred.passwordHash, parsed.data.password);
    } else {
      await verifyPassword(await dummyHash(), parsed.data.password).catch(() => false);
    }
    if (!user || !ok) {
      return c.json({ error: { code: 'INVALID_CREDENTIALS', message: '帳號或密碼錯誤' } }, 401);
    }
    if (await getTotpCredential(db, user.id)) {
      const challengeId = uuidv7();
      await createAuthChallenge(db, {
        id: challengeId,
        userId: user.id,
        kind: 'totp_login',
        challenge: randomBytes(32).toString('base64url'),
        expiresAt: new Date(Date.now() + 5 * 60_000),
      });
      return c.json({ requiresTotp: true, challengeId });
    }
    const { token, csrfToken } = await issueSession(db, env, user.id);
    setSessionCookie(c, env, token);
    return c.json({ userId: user.id, csrfToken });
  });

  app.post('/logout', async (c) => {
    const cookieToken = getCookie(c, SESSION_COOKIE);
    if (cookieToken) {
      await revokeSession(db, hashSessionToken(env.sessionSecret, cookieToken));
    }
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  return app;
}

export function hashInviteCode(secret: string, code: string): string {
  return createHmac('sha256', secret).update(`invite:${code}`).digest('hex');
}
