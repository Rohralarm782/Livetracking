// Service Worker – Live Tracking PWA
// Network-first: immer live Daten, kein aggressives Caching

// Version bei jeder Frontend-Aenderung hochzaehlen, sonst haelt das
// Handy die alten Dateien fest.
const CACHE = 'livetracking-v2';

// Nur das Geruest wird abgelegt. Alles unter diesen Pfaden ist statisch;
// Positionen, Gruppen und Rennen laufen ueber andere Pfade und duerfen
// nie aus dem Cache kommen.
const SHELL = /\.(?:html|css|js|svg|png|webmanifest)$|^\/$|\/manifest\.json$/;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => e.waitUntil((async () => {
  // Alte Versionen wegraeumen, sonst waechst der Speicher mit jedem Deploy.
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Fremde Hosts (Kartenkacheln, Leaflet-CDN) nicht anfassen.
  if (url.origin !== self.location.origin) return;
  const shell = SHELL.test(url.pathname);

  // Weiterhin Network-First: im Rennen zaehlt der frische Stand.
  // Neu ist nur, dass eine erfolgreiche Antwort abgelegt wird - vorher
  // hat caches.match() immer ins Leere gegriffen, weil nie jemand
  // etwas hineingeschrieben hat. Ohne Netz startete die App gar nicht.
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (shell && res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(e.request);
      if (hit) return hit;
      throw err;
    }
  })());
});
