import {
  deleteWebPushSubscription,
  getNotificationPreferences,
  listWebPushSubscriptions,
  newId,
  saveNotificationPreferences,
  saveWebPushSubscription,
  type Db,
  type NotificationPreferencesValue,
} from '@okane-dokoitta/database';
import { zNotificationPreferencesUpdate, zWebPushSubscribeRequest, zWebPushUnsubscribeRequest } from '@okane-dokoitta/schemas';
import { Hono } from 'hono';
import type { AuthContext } from './auth.js';
import type { ApiEnv } from './env.js';

type Variables = { auth: AuthContext };

/** 掛在 authed router 底下（app.ts）：全部需要登入 + CSRF。 */
export function notificationsRoutes(db: Db, env: ApiEnv): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.get('/preferences', async (c) => {
    const auth = c.get('auth');
    const prefs = await getNotificationPreferences(db, auth.userId);
    return c.json({ ...prefs, webPushVapidPublicKey: env.webPush?.vapidPublicKey ?? null });
  });

  app.post('/preferences', async (c) => {
    const auth = c.get('auth');
    const parsed = zNotificationPreferencesUpdate.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message ?? '格式錯誤' } }, 422);
    }
    const saved = await saveNotificationPreferences(db, auth.userId, parsed.data as Partial<NotificationPreferencesValue>);
    return c.json(saved);
  });

  app.post('/web-push/subscribe', async (c) => {
    const auth = c.get('auth');
    if (!env.webPush) return c.json({ error: { code: 'WEB_PUSH_NOT_CONFIGURED', message: 'Web Push 尚未設定' } }, 503);
    const parsed = zWebPushSubscribeRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message ?? '格式錯誤' } }, 422);
    }
    await saveWebPushSubscription(db, {
      id: newId(),
      userId: auth.userId,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
    });
    return c.json({ ok: true });
  });

  app.post('/web-push/unsubscribe', async (c) => {
    const auth = c.get('auth');
    const parsed = zWebPushUnsubscribeRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message ?? '格式錯誤' } }, 422);
    }
    await deleteWebPushSubscription(db, auth.userId, parsed.data.endpoint);
    return c.json({ ok: true });
  });

  app.get('/web-push/subscriptions', async (c) => {
    const auth = c.get('auth');
    const subs = await listWebPushSubscriptions(db, auth.userId);
    return c.json({ count: subs.length });
  });

  return app;
}
