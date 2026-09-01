// =======================
// MAIN LOOP
// =======================
loadPositions();
setInterval(loadPositions, 1000);
loadPending();
setInterval(loadPending, 3000);
// Die Spur ist Vergangenheit, sie muss nicht im Sekundentakt kommen.
// Alle 15 s reicht - und der erste Lauf holt alles bereits
// Aufgezeichnete, damit eine spaet geoeffnete Karte die komplette
// bisherige Strecke zeigt.
ladeSpuren();
setInterval(ladeSpuren, 15000);
// Holt beim ersten Lauf auch die Strecke. Ein zusaetzliches
// fetchGpxTrack() hier waere ein doppelter Request.
loadVersion();
loadActiveInfo();
setInterval(loadActiveInfo, 20000);
// Eigener Sekundentakt: die Uhr soll laufen, auch wenn gerade keine
// Position hereinkommt.
updateRaceClock();
setInterval(updateRaceClock, 1000);
loadMode();
pollGroups();
setInterval(pollGroups, 5000);

// Zeitmessung. Die Zuordnung aendert sich selten und wird nur beim
// Start und nach dem Einrichten geholt; der Vorschlag im gleichen Takt
// wie die Gruppen, damit Balken und Karten zusammenpassen.
loadTiming();
pollTiming();
setInterval(pollTiming, 5000);

// =======================
// TOAST
// =======================
// ms ist optional und faellt auf die bisherigen 2,5 s zurueck - alle
// vorhandenen Aufrufe bleiben unveraendert gueltig. Der Hinweis auf eine
// neue Version braucht laenger, der wird sonst im Auto uebersehen.
function showToast(msg, ms) {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'position:fixed;bottom:70px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.75);color:white;padding:8px 18px;border-radius:20px;font-size:13px;z-index:9999;pointer-events:none;';
  document.body.appendChild(el);
  const dauer = (typeof ms === 'number' && ms > 0) ? ms : 2500;
  setTimeout(() => { el.style.transition = 'opacity 0.5s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 500); }, dauer);
}

// =======================
// SERVICE WORKER (PWA)
// =======================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(e => console.error('SW:', e));
}

