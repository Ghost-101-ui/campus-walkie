/**
 * Hand-written Service Worker for Campus Walkie.
 *
 * Cache-first offline shell precaching, zero Workbox overhead.
 * The `"__PRECACHE__"` placeholder is replaced at build time by Vite plugin precacheManifest.
 */

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE_NAME = 'cw-v1';
const PRECACHE_URLS: string[] = "__PRECACHE__" as unknown as string[];

sw.addEventListener('install', (event: any) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      if (Array.isArray(PRECACHE_URLS)) {
        return cache.addAll(PRECACHE_URLS);
      }
      return Promise.resolve();
    }).then(() => sw.skipWaiting())
  );
});

sw.addEventListener('activate', (event: any) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => sw.clients.claim())
  );
});

sw.addEventListener('fetch', (event: any) => {
  // Only handle GET requests, ignore WebSocket signaling upgrades & API calls
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Stale-while-revalidate in background
        fetch(event.request).then((networkResponse) => {
          if (networkResponse.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
          }
        }).catch(() => {/* offline */});
        return cachedResponse;
      }
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
        return response;
      });
    })
  );
});
