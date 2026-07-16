'use strict';

/* 訂單辨識 PWA — Service Worker
 * 快取策略：網頁/程式碼「網路優先」（每次打開就是最新版，不用清快取／不用重裝），
 * 圖示等靜態資源「快取優先」保離線速度。僅攔截同源 GET。 */

const CACHE_VERSION = 'v1.4.0';
const CACHE_NAME = `orderscan-shell-${CACHE_VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只攔截同源 GET，其餘（例如 Gemini API / GAS POST）一律放行不快取
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  const path = new URL(req.url).pathname;
  // 網頁／JS／CSS／manifest：網路優先——打開就是最新版；離線才退回快取。
  const isShell = req.mode === 'navigate' || path.endsWith('/') || /\.(html|js|css|webmanifest)$/.test(path);

  if (isShell) {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.ok) {
            const copy = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return networkRes;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // 圖示等靜態資源：快取優先保離線速度，順手回填快取。
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((networkRes) => {
      if (networkRes && networkRes.ok) {
        const copy = networkRes.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
      }
      return networkRes;
    }))
  );
});
