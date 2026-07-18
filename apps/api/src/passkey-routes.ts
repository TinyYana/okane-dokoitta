import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  consumeAuthChallenge,
  consumeRecoveryCode,
  createAuthChallenge,
  findPasskey,
  findUserByEmail,
  getTotpCredential,
  listPasskeys,
  newId,
  replaceRecoveryCodes,
  savePasskey,
  saveTotpCredential,
  updatePasskeyCounter,
  type Db,
} from '@okane-dokoitta/database';
import { zUuidV7 } from '@okane-dokoitta/schemas';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import {
  checkCsrf,
  CSRF_HEADER,
  issueSession,
  resolveSession,
  SESSION_COOKIE,
  setSessionCookie,
} from './auth.js';
import { decryptSecret, encryptSecret } from './crypto-secrets.js';
import type { ApiEnv } from './env.js';

const CHALLENGE_TTL_MS = 5 * 60_000;
const zCeremony = z.object({ challengeId: zUuidV7, response: z.object({ id: z.string().min(1) }).passthrough() });
const zEmail = z.object({ email: z.email() });
const zRecovery = z.object({ email: z.email(), code: z.string().trim().min(8).max(100) });
const zTotpVerify = z.object({ challengeId: zUuidV7, code: z.string().regex(/^\d{6}$/) });
const zTotpLogin = z.object({ challengeId: zUuidV7, code: z.string().regex(/^\d{6}$/) });

export function passkeyRoutes(db: Db, env: ApiEnv): Hono {
  const app = new Hono();
  const { rpID, origin } = relyingParty(env);

  app.post('/passkeys/register/options', async (c) => {
    const auth = await resolveSession(db, env, getCookie(c, SESSION_COOKIE));
    if (!auth) return c.json({ error: { code: 'UNAUTHENTICATED', message: '請先登入' } }, 401);
    if (!checkCsrf(auth, c.req.header(CSRF_HEADER))) return c.json({ error: { code: 'CSRF_INVALID', message: 'CSRF token 無效' } }, 403);
    const existing = await listPasskeys(db, auth.userId);
    const options = await generateRegistrationOptions({
      rpName: 'okane-dokoitta',
      rpID,
      userID: Buffer.from(auth.userId.replaceAll('-', ''), 'hex'),
      userName: auth.email,
      userDisplayName: auth.displayName ?? auth.email,
      attestationType: 'none',
      excludeCredentials: existing.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    const challengeId = newId();
    await createAuthChallenge(db, {
      id: challengeId,
      userId: auth.userId,
      kind: 'registration',
      challenge: options.challenge,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    });
    return c.json({ challengeId, options });
  });

  app.post('/passkeys/register/verify', async (c) => {
    const auth = await resolveSession(db, env, getCookie(c, SESSION_COOKIE));
    if (!auth) return c.json({ error: { code: 'UNAUTHENTICATED', message: '請先登入' } }, 401);
    if (!checkCsrf(auth, c.req.header(CSRF_HEADER))) return c.json({ error: { code: 'CSRF_INVALID', message: 'CSRF token 無效' } }, 403);
    const parsed = zCeremony.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'PASSKEY_INVALID', message: 'Passkey 回應格式無效' } }, 422);
    const challenge = await consumeAuthChallenge(db, { id: parsed.data.challengeId, kind: 'registration', userId: auth.userId });
    if (!challenge) return c.json({ error: { code: 'CHALLENGE_EXPIRED', message: 'Passkey 驗證已過期，請重試' } }, 422);
    try {
      const result = await verifyRegistrationResponse({
        response: parsed.data.response as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
      if (!result.verified || !result.registrationInfo) throw new Error('not verified');
      const info = result.registrationInfo;
      await savePasskey(db, {
        id: newId(),
        userId: auth.userId,
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
        counter: BigInt(info.credential.counter),
        transports: info.credential.transports ?? [],
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
      });
      const recoveryCodes = (await listPasskeys(db, auth.userId)).length === 1 ? generateRecoveryCodes() : [];
      if (recoveryCodes.length > 0) {
        await replaceRecoveryCodes(db, auth.userId, recoveryCodes.map((code) => hashRecoveryCode(env.sessionSecret, code)));
      }
      return c.json({ verified: true, recoveryCodes });
    } catch {
      return c.json({ error: { code: 'PASSKEY_VERIFY_FAILED', message: '無法驗證 Passkey' } }, 422);
    }
  });

  app.post('/passkeys/login/options', async (c) => {
    const parsed = zEmail.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'INVALID_INPUT', message: '請輸入有效 Email' } }, 422);
    const user = await findUserByEmail(db, parsed.data.email);
    const credentials = user ? await listPasskeys(db, user.id) : [];
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: credentials.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.transports as AuthenticatorTransportFuture[],
      })),
    });
    const challengeId = newId();
    await createAuthChallenge(db, {
      id: challengeId,
      userId: user?.id ?? null,
      kind: 'authentication',
      challenge: options.challenge,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    });
    return c.json({ challengeId, options });
  });

  app.post('/passkeys/login/verify', async (c) => {
    const parsed = zCeremony.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'PASSKEY_INVALID', message: 'Passkey 回應格式無效' } }, 422);
    const challenge = await consumeAuthChallenge(db, { id: parsed.data.challengeId, kind: 'authentication' });
    const stored = await findPasskey(db, parsed.data.response.id);
    if (!challenge?.userId || !stored || stored.user.id !== challenge.userId) {
      return c.json({ error: { code: 'INVALID_CREDENTIALS', message: 'Passkey 驗證失敗' } }, 401);
    }
    try {
      const result = await verifyAuthenticationResponse({
        response: parsed.data.response as unknown as AuthenticationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        credential: {
          id: stored.passkey.credentialId,
          publicKey: new Uint8Array(Buffer.from(stored.passkey.publicKey, 'base64url')),
          counter: Number(stored.passkey.counter),
          transports: stored.passkey.transports as AuthenticatorTransportFuture[],
        },
      });
      if (!result.verified) throw new Error('not verified');
      await updatePasskeyCounter(db, stored.passkey.credentialId, BigInt(result.authenticationInfo.newCounter));
      const session = await issueSession(db, env, stored.user.id);
      setSessionCookie(c, env, session.token);
      return c.json({ userId: stored.user.id, csrfToken: session.csrfToken });
    } catch {
      return c.json({ error: { code: 'INVALID_CREDENTIALS', message: 'Passkey 驗證失敗' } }, 401);
    }
  });

  app.post('/recovery/login', async (c) => {
    const parsed = zRecovery.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'INVALID_INPUT', message: '恢復碼格式無效' } }, 422);
    const user = await findUserByEmail(db, parsed.data.email);
    const ok = user ? await consumeRecoveryCode(db, user.id, hashRecoveryCode(env.sessionSecret, parsed.data.code)) : false;
    if (!user || !ok) return c.json({ error: { code: 'INVALID_CREDENTIALS', message: 'Email 或恢復碼錯誤' } }, 401);
    const session = await issueSession(db, env, user.id);
    setSessionCookie(c, env, session.token);
    return c.json({ userId: user.id, csrfToken: session.csrfToken });
  });

  app.post('/totp/setup/options', async (c) => {
    const auth = await resolveSession(db, env, getCookie(c, SESSION_COOKIE));
    if (!auth) return c.json({ error: { code: 'UNAUTHENTICATED', message: '請先登入' } }, 401);
    if (!checkCsrf(auth, c.req.header(CSRF_HEADER))) return c.json({ error: { code: 'CSRF_INVALID', message: 'CSRF token 無效' } }, 403);
    const secret = base32Encode(randomBytes(20));
    const challengeId = newId();
    await createAuthChallenge(db, {
      id: challengeId,
      userId: auth.userId,
      kind: 'totp',
      challenge: encryptTotpSecret(env.sessionSecret, secret),
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    });
    const issuer = encodeURIComponent('okane-dokoitta');
    const account = encodeURIComponent(auth.email);
    return c.json({
      challengeId,
      secret,
      otpauthUrl: `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&digits=6&period=30`,
    });
  });

  app.post('/totp/setup/verify', async (c) => {
    const auth = await resolveSession(db, env, getCookie(c, SESSION_COOKIE));
    if (!auth) return c.json({ error: { code: 'UNAUTHENTICATED', message: '請先登入' } }, 401);
    if (!checkCsrf(auth, c.req.header(CSRF_HEADER))) return c.json({ error: { code: 'CSRF_INVALID', message: 'CSRF token 無效' } }, 403);
    const parsed = zTotpVerify.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'TOTP_INVALID', message: '請輸入 6 位驗證碼' } }, 422);
    const challenge = await consumeAuthChallenge(db, { id: parsed.data.challengeId, kind: 'totp', userId: auth.userId });
    if (!challenge) return c.json({ error: { code: 'CHALLENGE_EXPIRED', message: 'TOTP 設定已過期，請重試' } }, 422);
    const secret = decryptTotpSecret(env.sessionSecret, challenge.challenge);
    if (!verifyTotpCode(secret, parsed.data.code)) return c.json({ error: { code: 'TOTP_INVALID', message: '驗證碼錯誤' } }, 422);
    await saveTotpCredential(db, auth.userId, encryptTotpSecret(env.sessionSecret, secret));
    return c.json({ verified: true });
  });

  app.post('/totp/login', async (c) => {
    const parsed = zTotpLogin.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'INVALID_INPUT', message: '請輸入 6 位驗證碼' } }, 422);
    const challenge = await consumeAuthChallenge(db, { id: parsed.data.challengeId, kind: 'totp_login' });
    const credential = challenge?.userId ? await getTotpCredential(db, challenge.userId) : null;
    const valid = credential
      ? verifyTotpCode(decryptTotpSecret(env.sessionSecret, credential.encryptedSecret), parsed.data.code)
      : false;
    if (!challenge?.userId || !valid) return c.json({ error: { code: 'INVALID_CREDENTIALS', message: '驗證碼錯誤或已過期' } }, 401);
    const session = await issueSession(db, env, challenge.userId);
    setSessionCookie(c, env, session.token);
    return c.json({ userId: challenge.userId, csrfToken: session.csrfToken });
  });

  return app;
}

function relyingParty(env: ApiEnv): { rpID: string; origin: string } {
  const url = new URL(env.baseUrl ?? `http://localhost:${env.port}`);
  return { rpID: url.hostname, origin: url.origin };
}

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => `ODK-${randomBytes(5).toString('hex').toUpperCase()}`);
}

export function hashRecoveryCode(secret: string, code: string): string {
  return createHmac('sha256', secret).update(`recovery:${code.trim().toUpperCase()}`).digest('hex');
}

export function generateTotpCode(secret: string, timeMs = Date.now()): string {
  const counter = BigInt(Math.floor(timeMs / 30_000));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | (digest[offset + 1]! << 16)
    | (digest[offset + 2]! << 8)
    | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

export function verifyTotpCode(secret: string, code: string, timeMs = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const candidate = Buffer.from(code);
  return [-30_000, 0, 30_000].some((offset) => {
    const expected = Buffer.from(generateTotpCode(secret, timeMs + offset));
    return expected.length === candidate.length && timingSafeEqual(expected, candidate);
  });
}

function encryptTotpSecret(appSecret: string, plaintext: string): string {
  return encryptSecret(appSecret, 'totp', plaintext);
}

function decryptTotpSecret(appSecret: string, envelope: string): string {
  return decryptSecret(appSecret, 'totp', envelope);
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(input: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of input.toUpperCase().replaceAll('=', '')) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
