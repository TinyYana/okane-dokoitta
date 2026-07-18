/// <reference lib="webworker" />
import { createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare let self: ServiceWorkerGlobalScope;

// registerType 'autoUpdate' 配 injectManifest 時，skipWaiting/clientsClaim 要自己來——
// 少了這兩行，新版 SW 永遠卡在 waiting，使用者怎麼重新整理都是舊 bundle（實際咬過兩次）。
self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

precacheAndRoute(self.__WB_MANIFEST);

// SPA fallback（等同原本 generateSW 的 navigateFallback + navigateFallbackDenylist）：
// 離線或非快取路徑導覽一律回 index.html，但 /api/* 不接管（M2 離線鏡像走 IndexedDB，不是 SW 快取）。
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }));

// M5：Web Push 顯示（DISCORD_INTEGRATION §5、§7）——訊息內容已在伺服器套用隱私模式，這裡原樣顯示。
self.addEventListener('push', (event) => {
  const text = event.data?.text() ?? '記帳提醒';
  event.waitUntil(
    self.registration.showNotification('okane-dokoitta', {
      body: text,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/'));
});
