import { api } from './api.js';

/** VAPID 公鑰是 base64url 字串；PushManager.subscribe 要 Uint8Array（RFC 8291）。 */
function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replaceAll('-', '+').replaceAll('_', '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function subscribeWebPush(vapidPublicKey: string): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('這個瀏覽器不支援 Web Push');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('通知權限被拒絕');
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
  });
  const json = subscription.toJSON();
  await api.post('/api/notifications/web-push/subscribe', {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys?.['p256dh'], auth: json.keys?.['auth'] },
  });
}

export async function unsubscribeWebPush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await subscription.unsubscribe();
  await api.post('/api/notifications/web-push/unsubscribe', { endpoint: subscription.endpoint });
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}
