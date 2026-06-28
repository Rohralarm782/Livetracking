// Service Worker – Live Tracking PWA
// Network-first: immer live Daten, kein aggressives Caching

const CACHE = 'livetracking-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  // Nur GET-Requests cachen; API-Calls immer frisch
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
