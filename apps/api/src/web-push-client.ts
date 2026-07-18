import { buildPushPayload, type PushMessage, type PushSubscription, type VapidKeys } from '@block65/webcrypto-web-push';

export interface WebPushConfig {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  contactEmail: string;
}

export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** 回傳值：端點是否已失效（404/410，呼叫端應刪除該訂閱）。 */
export async function sendWebPush(config: WebPushConfig, subscription: StoredSubscription, content: string): Promise<{ gone: boolean }> {
  const vapid: VapidKeys = {
    subject: config.contactEmail.startsWith('mailto:') ? config.contactEmail : `mailto:${config.contactEmail}`,
    publicKey: config.vapidPublicKey,
    privateKey: config.vapidPrivateKey,
  };
  const pushSubscription: PushSubscription = {
    endpoint: subscription.endpoint,
    expirationTime: null,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth },
  };
  const message: PushMessage = { data: content, options: { ttl: 24 * 60 * 60 } };
  const payload = await buildPushPayload(message, pushSubscription, vapid);
  // payload.headers 型別含 optional topic/urgency，與 Workers fetch 的 HeadersInit 嚴格模式不完全相容，實際上是合法的 fetch init
  const res = await fetch(subscription.endpoint, payload as RequestInit);
  return { gone: res.status === 404 || res.status === 410 };
}
