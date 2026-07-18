import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';
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

let dummyHashCache: string | null = null;
async function argon2Hash(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(16),
    parallelism: 1,
    iterations: 2,
    memorySize: 19_456,
    hashLength: 32,
    outputType: 'encoded',
  }) as Promise<string>;
}

async function dummyHash(): Promise<string> {
  dummyHashCache ??= await argon2Hash('dummy-password-for-timing');
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
    const passwordHash = await argon2Hash(parsed.data.password); // 預設 argon2id
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
    const passwordHash = await argon2Hash(parsed.data.password);
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
      ok = await argon2Verify({ hash: cred.passwordHash, password: parsed.data.password });
    } else {
      await argon2Verify({ hash: await dummyHash(), password: parsed.data.password }).catch(() => false);
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
