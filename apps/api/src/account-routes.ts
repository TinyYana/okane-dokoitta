import { randomBytes } from 'node:crypto';
import {
  createRegistrationInvite,
  listRegistrationInvites,
  listInstanceUsers,
  newId,
  revokeRegistrationInvite,
  toJsonSafe,
  type Db,
} from '@okane-dokoitta/database';
import { zInviteCreate, zUuidV7 } from '@okane-dokoitta/schemas';
import { Hono } from 'hono';
import { hashInviteCode, type AuthContext } from './auth.js';
import type { ApiEnv } from './env.js';

type Variables = { auth: AuthContext };

export function accountRoutes(db: Db, env: ApiEnv): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    if (!c.get('auth').isAdmin) return c.json({ error: { code: 'FORBIDDEN', message: '只有管理者能管理邀請碼' } }, 403);
    await next();
  });

  app.get('/invites', async (c) => {
    return c.json(toJsonSafe({ invites: await listRegistrationInvites(db, c.get('auth').userId) }) as Record<string, unknown>);
  });

  app.get('/users', async (c) => {
    return c.json(toJsonSafe({ users: await listInstanceUsers(db) }) as Record<string, unknown>);
  });

  app.post('/invites', async (c) => {
    const parsed = zInviteCreate.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: { code: 'INVITE_INVALID', message: parsed.error.issues[0]?.message ?? '邀請設定無效' } }, 422);
    const code = randomBytes(24).toString('base64url');
    const id = newId();
    const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 86400_000);
    await createRegistrationInvite(db, {
      id,
      createdByUserId: c.get('auth').userId,
      codeHash: hashInviteCode(env.sessionSecret, code),
      expiresAt,
    });
    return c.json({ id, code, expiresAt: expiresAt.toISOString() });
  });

  app.post('/invites/:id/revoke', async (c) => {
    const id = zUuidV7.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: { code: 'INVITE_INVALID', message: '邀請 ID 無效' } }, 422);
    const ok = await revokeRegistrationInvite(db, c.get('auth').userId, id.data);
    return ok ? c.json({ ok: true }) : c.json({ error: { code: 'NOT_FOUND', message: '找不到邀請' } }, 404);
  });

  return app;
}
