// Service Worker – Live Tracking PWA
// Network-first: immer live Daten, kein aggressives Caching

// Der Cache-Name kommt aus version.json. Vorher stand hier eine Zahl,
// die bei jedem Frontend-Update von Hand hochzuzaehlen war - genau
// einmal vergessen, und das Handy haelt die alten Dateien fest.
//
// Der Rueckfall greift, wenn /version nicht erreichbar ist (offline
// beim Installieren). Dann wird derselbe Cache weiterbenutzt statt
// gar keiner.
const CACHE_PREFIX   = 'livetracking-';
const CACHE_RUECKFALL = CACHE_PREFIX + 'unbekannt';

let cacheNamePromise = null;

function cacheName() {
  if (!cacheNamePromise) {
    cacheNamePromise = fetch('/version', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => (d && typeof d.version === 'string')
        ? CACHE_PREFIX + d.version
        : CACHE_RUECKFALL)
      .catch(() => CACHE_RUECKFALL);
  }
  return cacheNamePromise;
}

// Nur das Geruest wird abgelegt. Alles unter diesen Pfaden ist statisch;
// Positionen, Gruppen und Rennen laufen ueber andere Pfade und duerfen
// nie aus dem Cache kommen.
const SHELL = /\.(?:html|css|js|svg|png|webmanifest)$|^\/$|\/manifest\.json$/;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => e.waitUntil((async () => {
  const name = await cacheName();
  // Alte Versionen wegraeumen, sonst waechst der Speicher mit jedem
  // Deploy. Steht die Version nicht fest, wird NICHT aufgeraeumt -
  // sonst loescht ein misslungener Abruf den einzigen Offline-Bestand.
  if (name !== CACHE_RUECKFALL) {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== name)
          .map(k => caches.delete(k)));
  }
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
        cacheName()
          .then(n => caches.open(n))
          .then(c => c.put(e.request, copy))
          .catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(e.request);
      if (hit) return hit;
      throw err;
    }
  })());
});
