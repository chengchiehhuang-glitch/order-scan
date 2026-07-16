'use strict';

/* 訂單辨識 PWA — Service Worker
 * 快取策略：stale-while-revalidate，僅攔截同源 GET 請求。
 * 升版時請同步更新下面的 CACHE_NAME 版本字串，讓舊快取自動失效。 */

const CACHE_VERSION = 'v1.2.0';
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

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(req).then((cached) => {
        const networkFetch = fetch(req)
          .then((networkRes) => {
            if (networkRes && networkRes.ok) {
              cache.put(req, networkRes.clone());
            }
            return networkRes;
          })
          .catch(() => cached); // 離線時退回快取
        return cached || networkFetch;
      })
    )
  );
});
