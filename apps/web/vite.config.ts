import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // M5：改用 injectManifest（自訂 src/sw.ts）才能加 push/notificationclick 監聽；
      // precache 行為（globPatterns/navigateFallback）維持原樣，只是搬進 injectManifest 設定
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      // PWA-1：iPhone 加入主畫面 standalone
      manifest: {
        name: 'okane-dokoitta',
        short_name: 'okane',
        description: 'お金どこいった？— 個人財務審計與資產中控台',
        lang: 'zh-Hant',
        display: 'standalone',
        start_url: '/',
        background_color: '#f5faf8',
        theme_color: '#207b67',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        // M1 線上版：只快取靜態資源；API 不快取（離線鏡像是 M2 的 IndexedDB）
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
