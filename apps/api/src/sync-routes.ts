import {
  attachSessionDevice,
  listChanges,
  listDevices,
  listUserSessions,
  registerDevice,
  renameDevice,
  revokeDevice,
  revokeUserSession,
  toJsonSafe,
  type Db,
} from '@okane-dokoitta/database';
import { zChangeCursor, zDeviceRegistration, zDeviceRename, zUuidV7 } from '@okane-dokoitta/schemas';
import { Hono } from 'hono';
import type { AuthContext } from './auth.js';

type Variables = { auth: AuthContext };

export function syncRoutes(db: Db): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.get('/changes', async (c) => {
    const since = zChangeCursor.safeParse(c.req.query('since') ?? '0');
    if (!since.success) return c.json({ error: { code: 'CURSOR_INVALID', message: '同步 cursor 無效' } }, 422);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 200) || 200, 1), 200);
    const changes = await listChanges(db, c.get('auth').userId, since.data, limit);
    const nextSince = changes.at(-1)?.seq ?? since.data;
    return c.json(toJsonSafe({ changes, nextSince }) as Record<string, unknown>);
  });

  app.post('/devices/register', async (c) => {
    const parsed = zDeviceRegistration.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { code: 'DEVICE_INVALID', message: parsed.error.issues[0]?.message ?? '裝置資料無效' } }, 422);
    const auth = c.get('auth');
    try {
      await registerDevice(db, { ...parsed.data, userId: auth.userId });
      await attachSessionDevice(db, auth.tokenHash, auth.userId, parsed.data.id);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: { code: 'DEVICE_REVOKED', message: '此裝置已撤銷，請重新登入' } }, 403);
    }
  });

  app.get('/devices', async (c) => {
    return c.json(toJsonSafe({ devices: await listDevices(db, c.get('auth').userId) }) as Record<string, unknown>);
  });

  app.post('/devices/:id/rename', async (c) => {
    const id = zUuidV7.safeParse(c.req.param('id'));
    const body = zDeviceRename.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success) return c.json({ error: { code: 'DEVICE_INVALID', message: '裝置資料無效' } }, 422);
    const ok = await renameDevice(db, c.get('auth').userId, id.data, body.data.name);
    return ok ? c.json({ ok: true }) : c.json({ error: { code: 'NOT_FOUND', message: '找不到裝置' } }, 404);
  });

  app.post('/devices/:id/revoke', async (c) => {
    const id = zUuidV7.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: { code: 'DEVICE_INVALID', message: '裝置 ID 無效' } }, 422);
    const ok = await revokeDevice(db, c.get('auth').userId, id.data);
    return ok ? c.json({ ok: true }) : c.json({ error: { code: 'NOT_FOUND', message: '找不到裝置' } }, 404);
  });

  app.get('/sessions', async (c) => {
    return c.json(toJsonSafe({ sessions: await listUserSessions(db, c.get('auth').userId) }) as Record<string, unknown>);
  });

  app.post('/sessions/:id/revoke', async (c) => {
    const id = zUuidV7.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: { code: 'SESSION_INVALID', message: 'Session ID 無效' } }, 422);
    const ok = await revokeUserSession(db, c.get('auth').userId, id.data);
    return ok ? c.json({ ok: true }) : c.json({ error: { code: 'NOT_FOUND', message: '找不到 session' } }, 404);
  });

  return app;
}
