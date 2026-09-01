// =======================
// MAP
// =======================
// Startausschnitt: bis 2.3.0 stand die Karte beim Laden fest auf
// Berlin, Zoom 13 - eine Vorgabe aus der ersten Fassung, die mit dem
// Rennort nur zufaellig zu tun hat. Jetzt beginnt sie mit ganz
// Deutschland; liegt eine Strecke vor, holt startAusschnitt() sie
// gleich darauf ins Bild.
// fitBounds statt fester Zoomstufe: der Ausschnitt soll auf dem Handy
// hochkant dasselbe zeigen wie auf dem Laptop.
const DEUTSCHLAND_BOUNDS = [[47.2, 5.8], [55.1, 15.1]];
const map = L.map('map').fitBounds(DEUTSCHLAND_BOUNDS);

// Zwei Kartenstile zur Auswahl. Voyager ist die Vorgabe: entsaettigt,
// wenig Beschriftung, kaum Symbole - die orange Streckenlinie und die
// Marker liegen praktisch allein auf grauem Grund. Auf dem
// OSM-Standard konkurriert dieselbe Linie mit orangen Autobahnen und
// gelben Landstrassen, und im fahrenden Auto entscheidet das darueber,
// ob man den Verlauf in zwei Sekunden erfasst oder suchen muss.
// OSM-Standard bleibt waehlbar: er beschriftet mehr und hilft in duenn
// besiedelten Gegenden bei der Orientierung.
// braucht_key: CARTO verlangt seit August 2026 einen Schluessel fuer
// die Raster-Kacheln. Ohne ihn liegt ueber jeder Kachel ein
// Wasserzeichen. Der Schluessel kommt aus der Server-Umgebung, siehe
// ladeCartoKey().
const TILE_STYLES = {
  voyager: {
    label: 'Voyager',
    url:   'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    braucht_key: true,
    opts:  { maxZoom: 20, subdomains: 'abcd',
             attribution: '&copy; OpenStreetMap, &copy; CARTO' }
  },
  osm: {
    label: 'OSM',
    url:   'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    braucht_key: false,
    opts:  { maxZoom: 19, subdomains: 'abc',
             attribution: '&copy; OpenStreetMap' }
  }
};

let tileStyle = localStorage.getItem('tileStyle') === 'osm' ? 'osm' : 'voyager';
let tileLayer = null;

// Womit die aktuelle Ebene gebaut wurde. Damit ein nachgereichter
// Schluessel die Kacheln nur dann neu anfordert, wenn sich wirklich
// etwas geaendert hat - sonst blitzt die Karte bei jedem Start einmal
// weiss auf.
let tileLayerUrl = null;
let tileLayerKey = null;

// Laeuft hoch bei jedem Stilwechsel. Eine spaet eintreffende Antwort
// darf den inzwischen gewaehlten Stil nicht ueberschreiben.
let tileLadeLauf = 0;

// null = noch nie geholt, '' = es gibt keinen. Der zuletzt erfolgreich
// geholte Schluessel liegt im localStorage: Render Free schlaeft nach
// 15 Minuten ein und braucht fuer die erste Antwort mehrere Sekunden -
// ohne diesen Zwischenspeicher bliebe die Karte so lange grau.
const CARTO_KEY_SPEICHER = 'cartoKey';
let cartoKey = localStorage.getItem(CARTO_KEY_SPEICHER);
let cartoKeyPromise = null;

function ladeCartoKey() {
  if (cartoKeyPromise) return cartoKeyPromise;
  cartoKeyPromise = fetch(SERVER + '/mapconfig', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      const k = (d && typeof d.cartoKey === 'string') ? d.cartoKey : '';
      cartoKey = k;
      if (k) localStorage.setItem(CARTO_KEY_SPEICHER, k);
      else   localStorage.removeItem(CARTO_KEY_SPEICHER);
      if (!k) console.warn('\u26A0\uFE0F Kein Kartenschluessel - Voyager mit Wasserzeichen.');
      return k;
    })
    .catch(() => {
      // Kein Netz oder Server schlaeft. Ein bekannter Schluessel bleibt
      // gueltig; sonst wird Voyager ohne Schluessel geladen. Bewusst
      // KEIN stiller Wechsel auf OSM - der Stil bleibt der gewaehlte.
      const k = cartoKey || '';
      cartoKey = k;
      console.warn('\u26A0\uFE0F Kartenschluessel nicht abrufbar.');
      return k;
    });
  return cartoKeyPromise;
}

// Baut die Kachel-Ebene. lauf schuetzt vor veralteten Antworten, der
// Vergleich von URL und Schluessel vor ueberfluessigem Neuaufbau.
function setzeTileLayer(def, key, lauf) {
  if (lauf !== tileLadeLauf) return;
  if (tileLayer && tileLayerUrl === def.url && tileLayerKey === key) return;
  if (tileLayer) map.removeLayer(tileLayer);
  const url = def.url + (key ? '?key=' + encodeURIComponent(key) : '');
  // Ganz nach unten: sonst liegen die frischen Kacheln ueber Strecke,
  // Spuren und Markern.
  tileLayer = L.tileLayer(url, def.opts).addTo(map);
  tileLayer.bringToBack();
  tileLayerUrl = def.url;
  tileLayerKey = key;
}

function applyTileStyle(key) {
  const def = TILE_STYLES[key] || TILE_STYLES.voyager;
  tileStyle = TILE_STYLES[key] ? key : 'voyager';
  const seg = document.getElementById('mapStyleSeg');
  if (seg) seg.querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.style === tileStyle);
  });
  localStorage.setItem('tileStyle', tileStyle);

  const lauf = ++tileLadeLauf;
  // OSM braucht keinen Schluessel und laedt wie bisher sofort, ohne
  // einen einzigen Netzaufruf abzuwarten.
  if (!def.braucht_key) { setzeTileLayer(def, '', lauf); return; }
  // Bekannter Schluessel: sofort zeichnen. Beim allerersten Aufruf auf
  // einem Geraet ist er unbekannt, dann bleibt die Kartenflaeche kurz
  // leer statt gewaesserte Kacheln zu holen, die der Browser-Cache
  // anschliessend festhaelt.
  if (cartoKey !== null) setzeTileLayer(def, cartoKey, lauf);
  ladeCartoKey().then(k => setzeTileLayer(def, k, lauf));
}

applyTileStyle(tileStyle);

// Das Einstellungs-Sheet deckt nur den unteren Teil ab: der Wechsel ist
// sofort auf der Karte zu sehen, eine Vorschau im Menue eruebrigt sich.
document.getElementById('mapStyleSeg').addEventListener('click', e => {
  const b = e.target.closest('button[data-style]');
  if (b) applyTileStyle(b.dataset.style);
});

// =======================
// STATE
// =======================
const markers       = {};
// Marker-ID -> zuletzt gesetzte Rennfarbe (null = keine Zuordnung).
// Ohne diesen Merker muesste bei jedem Poll das Icon neu gebaut werden.
const markerRace    = {};
const lastPositions = {};
const trails        = {};
let currentMarkerMenu = null;
let firstDevice  = true;
let lastDataTime = null;
let autoZoom     = true;
// Wurde der Startausschnitt schon gesetzt - entweder von
// startAusschnitt() auf die Strecken oder vom Sprung auf den ersten
// Tracker? Beide kommen aus verschiedenen Abfragen und damit in
// unvorhersehbarer Reihenfolge; wer zuerst da ist, gewinnt. Ohne
// diesen gemeinsamen Merker springt die Karte sichtbar zurueck, wenn
// die Strecke nach der ersten Position eintrifft.
let startAusschnittGesetzt = false;

// Zeitabgleich und Gruppen. Muss hier oben stehen, nicht erst bei den
// Hilfsfunktionen weiter unten: die Bedienelemente werden schon beim
// autoZoomBtn verdrahtet, und mit let deklarierte Variablen sind vor
// ihrer Deklaration nicht zugreifbar - die Datei braeche dort ab.
let syncOn   = localStorage.getItem('syncPref')  === 'on';
let groupOn  = localStorage.getItem('groupPref') === 'on';
let syncLagS = (() => {
  const v = parseInt(localStorage.getItem('syncLagS'), 10);
  return (isFinite(v) && v >= 5 && v <= 60) ? v : 25;
})();

const GROUP_MAX_M = 30;
let historyData = {};
const groupMarkers = {};
// Ab wann eine Position als veraltet gilt. Im Renn-Modus meldet ein
// Tracker alle 2 s (bewegt) bzw. 30 s (stehend), im Training alle
// 10/60 s - 3 Minuten Stille heisst also wirklich "meldet nicht mehr".
// Wichtig, weil der Server Positionen nie von selbst verwirft: die
// Marker des Vormittagsrennens stehen sonst nachmittags noch da.
const STALE_MS   = 3 * 60 * 1000;
// Schwelle fuer die Statuszeile. Muss ueber dem Stehend-Intervall von
// 30 s liegen, sonst meldet ein wartendes Feld dauernd "Offline".
const OFFLINE_MS = 75 * 1000;
// Punkte je Spur. Bei 2-s-Takt entspricht das etwa der letzten Stunde.
const TRAIL_MAX_POINTS = 1800;
// Spur je Tracker, wie der Server sie aufgezeichnet hat.
// id -> [ [t, lat, lon], ... ], aufsteigend nach t.
const spurDaten = {};
// Zeitstempel des letzten /track-Abrufs, vom Server geliefert. Danach
// wird nur noch der Zuwachs geholt.
let spurCursor = 0;
// Groesser als diese Luecke heisst: dazwischen lag keine Aufzeichnung.
// Dann wird die Linie unterbrochen statt quer ueber die Karte gezogen -
// genau das war der Fehler, den eine im Hintergrund eingefrorene Seite
// erzeugt hat.
const SPUR_GAP_MS = 60 * 1000;
// Tracker, die online sind, aber noch keinen GPS-Fix haben.
// [{ id, displayName, sats, since, timestamp }]
let pendingTrackers = [];

// =======================
// TEAMAUTO MARKER
// =======================
const teamCarIcon = L.divIcon({
  className: '',
  html: `<div style="background:#e53935;border:3px solid white;border-radius:50% 50% 50% 0;transform:rotate(-45deg);width:22px;height:22px;box-shadow:0 2px 6px rgba(0,0,0,0.4);"></div>`,
  iconSize: [28, 28], iconAnchor: [14, 28], tooltipAnchor: [0, -28]
});

const betreuerIcon = L.divIcon({
  className: '',
  html: `<div style="background:#ff9800;border:3px solid white;border-radius:4px;width:22px;height:22px;box-shadow:0 2px 6px rgba(0,0,0,0.4);"></div>`,
  iconSize: [28, 28], iconAnchor: [14, 14], tooltipAnchor: [0, -16]
});

let teamCarMarker    = null;
let teamCarWatchId   = null;
let teamCarAccCircle = null;

function startTeamCarTracking() {
  if (!authToken) {
    showLoginModal('\u{1F697} Zum Aktivieren des Teamauto-Trackings');
    document.getElementById('teamCarCheckbox').checked = false;
    return;
  }
  if (!navigator.geolocation) {
    alert("GPS wird von diesem Browser nicht unterst\u00FCtzt.");
    document.getElementById('teamCarCheckbox').checked = false;
    return;
  }
  teamCarWatchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const latlng   = [pos.coords.latitude, pos.coords.longitude];
      const accuracy = pos.coords.accuracy;
      try {
        await fetch(`${SERVER}/team-position`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          body: JSON.stringify({ lat: latlng[0], lon: latlng[1] })
        });
      } catch (err) { console.error("Fehler beim Senden:", err); }

      if (!teamCarMarker) {
        teamCarMarker = L.marker(latlng, { icon: teamCarIcon, zIndexOffset: 1000 })
          .addTo(map);
        teamCarAccCircle = L.circle(latlng, {
          radius: accuracy, color: '#e53935', fillColor: '#e53935', fillOpacity: 0.08, weight: 1
        }).addTo(map);
      } else {
        teamCarMarker.setLatLng(latlng);
        teamCarAccCircle.setLatLng(latlng);
        teamCarAccCircle.setRadius(accuracy);
      }
    },
    (err) => {
      console.error("Geolocation-Fehler:", err.message);
      if (err.code === 1) {
        alert("GPS-Zugriff verweigert.");
        document.getElementById('teamCarCheckbox').checked = false;
        document.getElementById('teamCarToggle').classList.remove('active');
      }
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
  );
}

function stopTeamCarTracking() {
  if (teamCarWatchId !== null) { navigator.geolocation.clearWatch(teamCarWatchId); teamCarWatchId = null; }
  if (teamCarMarker)    { map.removeLayer(teamCarMarker);    teamCarMarker    = null; }
  if (teamCarAccCircle) { map.removeLayer(teamCarAccCircle); teamCarAccCircle = null; }
}

document.getElementById('teamCarCheckbox').addEventListener('change', function () {
  document.getElementById('teamCarToggle').classList.toggle('active', this.checked);
  if (this.checked) startTeamCarTracking(); else stopTeamCarTracking();
});

// =======================
// STATUS
// =======================
const statusEl = document.getElementById('status');

function updateStatus() {
  const searching = pendingTrackers.length;

  if (!lastDataTime) {
    statusEl.className   = 'warn';
    statusEl.textContent = '\u26AA Warte auf Daten\u2026';
    return;
  }
  const ago = (Date.now() - lastDataTime) / 1000;
  if (ago * 1000 >= OFFLINE_MS) {
    statusEl.className   = 'warn';
    statusEl.textContent = `\u{1F534} Offline (${Math.round(ago)}s)`;
    return;
  }
  const trackerIds = Object.keys(lastPositions)
    .filter(id => id !== 'TEAMAUTO' && !id.startsWith('betreuer-'));

  // Noch gar keine Position, aber jemand sucht: eigener Zustand.
  // Ohne das stuende hier "Verbunden \u00B7 Rennen", obwohl noch
  // kein einziger Punkt auf der Karte ist.
  if (trackerIds.length === 0 && searching > 0) {
    statusEl.className   = 'searching';
    statusEl.textContent = `\u{1F6F0} Sucht GPS (${searching})`;
    return;
  }

  const suffix = searching > 0 ? ` \u00B7 ${searching}\u00D7 sucht GPS` : '';
  const modes = trackerIds
    .map(id => lastPositions[id] && lastPositions[id].trackerMode)
    .filter(Boolean);
  const inTraining = modes.some(m => m === 'training');
  if (inTraining) {
    statusEl.className   = 'training';
    statusEl.textContent = '\u{1F7E1} Verbunden \u00B7 Training' + suffix;
  } else {
    statusEl.className   = 'ok';
    statusEl.textContent = '\u{1F7E2} Verbunden \u00B7 Rennen' + suffix;
  }
}
setInterval(updateStatus, 1000);

// =======================
// SMOOTH MARKER ANIMATION
// =======================
function animateMarker(marker, from, to, duration = 800) {
  const start = performance.now();
  function step(time) {
    const t   = Math.min((time - start) / duration, 1);
    const lat = from[0] + (to[0] - from[0]) * t;
    const lng = from[1] + (to[1] - from[1]) * t;
    marker.setLatLng([lat, lng]);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// =======================
// BATTERIE-ANZEIGE
// =======================
function batLabel(bat) {
  if (typeof bat !== 'number') return '';
  const color = bat >= 60 ? '#2e7d32' : bat >= 30 ? '#e65100' : '#c62828';
  const icon  = bat >= 60 ? '\u{1F7E2}' : bat >= 30 ? '\u{1F7E1}' : '\u{1F534}';
  return ` <span style="color:${color};font-size:11px">${icon} ${bat}%</span>`;
}

// "4 min" bzw. "2:15 h" - kurz genug fuer das Tooltip am Marker
function ageLabel(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 60) return min + ' min';
  return Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0') + ' h';
}

function tooltipContent(id, bat, age, avgKmh) {
  const old = (typeof age === 'number' && age > STALE_MS)
    ? ` <span style="color:#c62828;font-size:11px">\u23F8 ${ageLabel(age)}</span>`
    : '';
  // Schnitt nur, wenn der Server einen liefert - er braucht dafuer eine
  // Startzeit und mindestens eine halbe Minute Rennen.
  const avg = (typeof avgKmh === 'number')
    ? ` <span style="color:#666;font-size:11px">\u00D8 ${avgKmh.toFixed(1).replace('.', ',')}</span>`
    : '';
  return id + batLabel(bat) + avg + old;
}

// =======================
// MARKER-SYMBOLE
// =======================
// Der Standard-Pin von Leaflet, unveraendert wie bis 1.15.1. Als
// Funktion, damit ihn das Zuruecksetzen nach dem Aufheben einer
// Zuordnung wiederverwenden kann.
function standardPin() {
  return L.icon({
    iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
    iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
  });
}

// Pin in der Farbe des Rennens. Bewusst als Inline-SVG statt als
// eingefaerbtes PNG: die Farbe kommt vom Server und ist damit nicht im
// Voraus bekannt, ein CSS-Filter auf das blaue Standardbild trifft sie
// nicht. Masse und Ankerpunkt sind identisch zum Standard-Pin, damit
// die Spitze weiter genau auf der Position sitzt.
function rennPin(farbe) {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="25" height="41" viewBox="0 0 25 41">' +
    '<path d="M12.5 0.8C6 0.8 0.8 6 0.8 12.5c0 8.8 11.7 27.4 11.7 27.4S24.2 21.3 24.2 12.5' +
    'C24.2 6 19 0.8 12.5 0.8z" fill="' + farbe + '" stroke="#ffffff" stroke-width="1.6"/>' +
    '<circle cx="12.5" cy="12.5" r="4.6" fill="#ffffff" fill-opacity="0.9"/></svg>';
  return L.divIcon({
    className: 'rennPin', html: svg,
    iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34]
  });
}

// Marker und Spur auf die Rennfarbe setzen. Faerbt beides, damit ein
// Tracker im Rennen als Ganzes erkennbar ist und nicht nur sein Kopf.
function setzeRennFarbe(id, farbe) {
  const neu = farbe || null;
  if (markerRace[id] === neu) return;
  markerRace[id] = neu;
  if (markers[id]) markers[id].setIcon(neu ? rennPin(neu) : standardPin());
  if (trails[id])  trails[id].setStyle({ color: neu || '#3388ff' });
}

// =======================
// CONTEXT MENU
// =======================
async function deleteTracker(markerId) {
  try {
    const res = await fetch(`${SERVER}/positions/${encodeURIComponent(markerId)}`, {
      method: 'DELETE', headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (!res.ok) { checkAuth(res); showToast('\u26A0\uFE0F Entfernen fehlgeschlagen'); return; }
    if (markers[markerId]) { map.removeLayer(markers[markerId]); delete markers[markerId]; }
    if (trails[markerId])  { map.removeLayer(trails[markerId]);  delete trails[markerId];  }
    delete markerRace[markerId];
    delete lastPositions[markerId];
    delete spurDaten[markerId];
    showToast('\u{1F5D1} Marker entfernt');
  } catch (err) { showToast('\u26A0\uFE0F ' + err.message); }
}

function showMarkerMenu(e, markerId) {
  if (authLevel !== 'spolei') return;
  if (currentMarkerMenu) currentMarkerMenu.remove();

  const container = document.createElement('div');
  container.className = 'markerMenu';
  container.style.left = e.pageX + 'px';
  container.style.top  = e.pageY + 'px';

  const input = document.createElement('input');
  input.type = 'text'; input.placeholder = 'Neuer Name\u2026'; input.value = markerId;

  const renameBtn = document.createElement('button');
  renameBtn.textContent = '\u270F\uFE0F Umbenennen';
  renameBtn.addEventListener('click', async () => {
    const newName = input.value.trim();
    if (!newName || newName === markerId) { container.remove(); return; }
    try {
      const res = await fetch(`${SERVER}/rename-tracker`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ trackerId: markerId, newName })
      });
      if (!res.ok) { alert('\u274C Fehler beim Umbenennen'); return; }
      // Bewusst NUR das Tooltip anfassen. Frueher wurden markers,
      // lastPositions und trails auf den neuen Namen umgeschluesselt -
      // der Server liefert unter /positions aber weiterhin die
      // Hardware-ID. Beim naechsten Poll fand loadPositions() unter
      // der ID keinen Marker mehr und legte einen zweiten an: ein
      // toter umbenannter und ein lebender namenloser Marker auf
      // demselben Punkt. Der Anzeigename kommt jetzt als
      // pos.displayName von selbst mit.
      if (markers[markerId]) markers[markerId].setTooltipContent(newName);
      container.remove();
    } catch (err) { alert('\u274C Fehler: ' + err.message); }
  });

  // Karteileiche einzeln entfernen. Bisher half nur "Karte leeren" -
  // das nimmt aber auch alle laufenden Tracker mit. Das Alter steht
  // dabei, damit man sieht, ob der Marker wirklich tot ist.
  const p   = lastPosData[markerId];
  const age = (p && p.timestamp) ? Date.now() - p.timestamp : null;
  const delBtn = document.createElement('button');
  delBtn.className   = 'markerDel';
  delBtn.textContent = '\u{1F5D1} Entfernen'
    + (age !== null && age > STALE_MS ? ` (still seit ${ageLabel(age)})` : '');
  delBtn.addEventListener('click', () => {
    container.remove();
    if (confirm(`Marker \u201E${markerId}\u201C von der Karte nehmen?`)) deleteTracker(markerId);
  });

  // Rennzuordnung. Steht zwischen Umbenennen und Entfernen, weil sie
  // zur Vorbereitung gehoert und nicht zum Aufraeumen.
  const zuTitel = document.createElement('div');
  zuTitel.className   = 'markerZuTitel';
  zuTitel.textContent = '\u{1F3C1} Rennen';

  const sel = document.createElement('select');
  sel.className = 'markerZu';
  sel.innerHTML = '<option value="">Keinem Rennen zugeordnet</option>';
  const aktuell = (lastPosData[markerId] && lastPosData[markerId].raceId) || '';
  fuelleRennAuswahl(sel, aktuell);
  sel.addEventListener('change', async () => {
    const wert = sel.value || null;
    try {
      const res = await fetch(`${SERVER}/tracker-race`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ trackerId: markerId, raceId: wert })
      });
      if (!res.ok) { checkAuth(res); showToast('\u26A0\uFE0F Zuordnung fehlgeschlagen'); return; }
      const data = await res.json();
      // Sofort faerben statt auf den naechsten Poll zu warten.
      setzeRennFarbe(markerId, data.color || null);
      if (lastPosData[markerId]) {
        lastPosData[markerId].raceId    = data.raceId || undefined;
        lastPosData[markerId].raceColor = data.color  || undefined;
      }
      showToast(wert ? '\u{1F517} Zugeordnet' : '\u{1F517} Zuordnung aufgehoben');
      container.remove();
    } catch (err) { showToast('\u26A0\uFE0F ' + err.message); }
  });

  container.appendChild(input);
  container.appendChild(renameBtn);
  container.appendChild(zuTitel);
  container.appendChild(sel);
  container.appendChild(delBtn);
  document.body.appendChild(container);
  currentMarkerMenu = container;
  input.focus(); input.select();
}

// Rennliste in ein <select> fuellen. Die Rennen stehen in eventList aus
// race/events.js - die wird aber erst beim Oeffnen der Rennverwaltung
// geladen. Wer direkt auf der Karte zuordnet, hat sie noch nicht,
// deshalb wird bei Bedarf nachgeladen und danach nachgetragen.
function fuelleRennAuswahl(sel, aktuell) {
  const eintragen = () => {
    const rennen = (typeof allRaces === 'function') ? allRaces() : [];
    for (const r of rennen) {
      if (r.status === 'beendet' && r.id !== aktuell) continue;
      const o = document.createElement('option');
      o.value       = r.id;
      o.textContent = r.name + (r.category ? ' \u00B7 ' + r.category : '')
                    + (r.isActive ? ' (aktiv)' : '');
      if (r.id === aktuell) o.selected = true;
      sel.appendChild(o);
    }
  };
  if (typeof allRaces === 'function' && allRaces().length > 0) { eintragen(); return; }
  if (typeof loadEvents === 'function') loadEvents().then(eintragen).catch(() => {});
}

// =======================
// AUTO-ZOOM TOGGLE
// =======================
function updateSyncUi() {
  const sw  = document.getElementById('syncSwitch');
  const sub = document.getElementById('syncSub');
  const row = document.getElementById('syncLagRow');
  const val = document.getElementById('syncLagVal');
  const rng = document.getElementById('syncLagRange');
  if (!sw) return;
  sw.classList.toggle('on', syncOn);
  if (sub) sub.textContent = syncOn
    ? 'Alle Fahrer auf denselben Zeitpunkt gerechnet. Die Karte hinkt um den Rueckstand hinterher.'
    : 'Aus. Jeder Marker zeigt seine letzte Meldung \u2013 unterschiedlich alt.';
  if (row) row.classList.toggle('hidden', !syncOn);
  if (val) val.textContent = syncLagS + ' s';
  if (rng) rng.value = syncLagS;
}

function updateGroupUi() {
  const sw  = document.getElementById('groupSwitch');
  const sub = document.getElementById('groupSub');
  if (!sw) return;
  sw.classList.toggle('on', groupOn);
  if (sub) sub.textContent = groupOn
    ? 'Fahrer im Umkreis von 30 m werden zu einem Marker zusammengefasst.'
    : 'Aus. Jeder Fahrer bekommt einen eigenen Marker.';
}

document.getElementById('syncSwitch').addEventListener('click', () => {
  syncOn = !syncOn;
  localStorage.setItem('syncPref', syncOn ? 'on' : 'off');
  if (!syncOn) historyData = {};
  updateSyncUi();
  loadPositions();
});

document.getElementById('syncLagRange').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10);
  if (!isFinite(v)) return;
  syncLagS = v;
  localStorage.setItem('syncLagS', String(v));
  const val = document.getElementById('syncLagVal');
  if (val) val.textContent = v + ' s';
});

document.getElementById('groupSwitch').addEventListener('click', () => {
  groupOn = !groupOn;
  localStorage.setItem('groupPref', groupOn ? 'on' : 'off');
  updateGroupUi();
  loadPositions();
});

updateSyncUi();
updateGroupUi();

document.getElementById('autoZoomBtn').addEventListener('click', () => {
  autoZoom = !autoZoom;
  const btn = document.getElementById('autoZoomBtn');
  btn.textContent = autoZoom ? '\u{1F3AF} Auto-Zoom: Ein' : '\u{1F3AF} Auto-Zoom: Aus';
  btn.classList.toggle('active', autoZoom);
});

// =======================
// LOAD POSITIONS
// =======================
// =======================
// ZEITABGLEICH UND GRUPPEN
// =======================
// Marker sind unterschiedlich alt: ist einer 2 s alt und der andere
// 20 s, klaffen bei 45 km/h ueber 200 m Phantomabstand, obwohl die
// beiden nebeneinander fahren. Der Zeitabgleich rechnet stattdessen
// alle Fahrer auf denselben Zeitpunkt - "jetzt minus Rueckstand" -
// und interpoliert dafuer zwischen den Punkten aus /history.
//
// Der Preis ist ein Kartenbild, das der Wirklichkeit um den
// Rueckstand hinterherhinkt. Fuer die taktische Beurteilung zaehlen
// die Abstaende zueinander, nicht die absolute Aktualitaet.
// Zwischen den beiden umgebenden Punkten linear interpolieren.
// exakt=false heisst: der Zeitpunkt liegt ausserhalb des Verlaufs,
// zurueck kommt dann der Rand. Das passiert bei einem Funkloch - und
// muss sichtbar sein, damit ein stiller Tracker nicht wie ein
// abgehaengter Fahrer aussieht.
function interpoliere(pts, t) {
  if (!Array.isArray(pts) || pts.length === 0) return null;
  const erster = pts[0], letzter = pts[pts.length - 1];
  if (t <= erster.t)  return { lat: erster.lat,  lon: erster.lon,  s: erster.s,  exakt: false };
  if (t >= letzter.t) return { lat: letzter.lat, lon: letzter.lon, s: letzter.s, exakt: false };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (t < a.t || t > b.t) continue;
    const f = (b.t === a.t) ? 0 : (t - a.t) / (b.t - a.t);
    const out = {
      lat: a.lat + (b.lat - a.lat) * f,
      lon: a.lon + (b.lon - a.lon) * f,
      exakt: true
    };
    // s nur interpolieren, wenn kein Rundenschluss dazwischenliegt -
    // sonst mittelt man zwischen Streckenende und Streckenanfang.
    if (typeof a.s === 'number' && typeof b.s === 'number') {
      out.s = (Math.abs(b.s - a.s) < 1000) ? a.s + (b.s - a.s) * f : a.s;
    } else if (typeof a.s === 'number') {
      out.s = a.s;
    }
    return out;
  }
  return null;
}

function anzeigePosition(id, pos, zielT, isBetreuer) {
  // Betreuer stehen fest an der Verpflegungszone - nichts abzugleichen.
  if (!syncOn || isBetreuer) return { lat: pos.lat, lon: pos.lon, unsicher: false };
  const ip = interpoliere(historyData[id], zielT);
  if (!ip) return { lat: pos.lat, lon: pos.lon, unsicher: true };
  return { lat: ip.lat, lon: ip.lon, s: ip.s, unsicher: !ip.exakt };
}

// Entlang der Strecke messen, wenn beide ein s haben. Zwei Fahrer
// beidseits einer Haarnadel sind luftlinienmaessig 50 m auseinander
// und streckenmaessig 800 m - nur der zweite Wert taugt.
function abstandM(a, b) {
  if (typeof a.s === 'number' && typeof b.s === 'number') return Math.abs(a.s - b.s);
  const dLat = (a.lat - b.lat) * 111320;
  const dLon = (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}

function bildeGruppen(liste) {
  const rest = liste.slice();
  const gruppen = [];
  while (rest.length) {
    const kern = rest.shift();
    const g = [kern];
    for (let i = rest.length - 1; i >= 0; i--) {
      if (abstandM(kern, rest[i]) <= GROUP_MAX_M) g.push(rest.splice(i, 1)[0]);
    }
    gruppen.push(g);
  }
  return gruppen;
}

function gruppenIcon(n) {
  return L.divIcon({
    className: '',
    html: `<div class="lt-group-bubble">${n}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17]
  });
}

// Mitglieder einer Gruppe verschwinden von der Karte, dafuer kommt ein
// Kreis mit der Anzahl. Die Marker werden nur aus- und wieder
// eingehaengt, nicht zerstoert - Tooltip, Kontextmenue und Spur
// bleiben dadurch erhalten.
function zeichneGruppen(kandidaten) {
  const gebraucht = new Set();

  if (groupOn) {
    bildeGruppen(kandidaten).forEach(g => {
      if (g.length < 2) return;
      const key = g.map(x => x.id).sort().join('|');
      gebraucht.add(key);
      const lat = g.reduce((a, x) => a + x.lat, 0) / g.length;
      const lon = g.reduce((a, x) => a + x.lon, 0) / g.length;
      const namen = g.map(x => x.name).join(' \u00B7 ');

      g.forEach(x => { if (map.hasLayer(markers[x.id])) map.removeLayer(markers[x.id]); });

      if (!groupMarkers[key]) {
        groupMarkers[key] = L.marker([lat, lon], { icon: gruppenIcon(g.length), zIndexOffset: 500 })
          .addTo(map)
          .bindTooltip(`${g.length} Fahrer \u2013 ${namen}`, { permanent: true, direction: 'top' });
      } else {
        groupMarkers[key].setLatLng([lat, lon]);
        groupMarkers[key].setTooltipContent(`${g.length} Fahrer \u2013 ${namen}`);
      }
    });
  }

  Object.keys(groupMarkers).forEach(k => {
    if (gebraucht.has(k)) return;
    map.removeLayer(groupMarkers[k]);
    delete groupMarkers[k];
  });

  // Alles, was nicht (mehr) in einer Gruppe steckt, gehoert zurueck
  // auf die Karte.
  const versteckt = new Set();
  gebraucht.forEach(k => k.split('|').forEach(id => versteckt.add(id)));
  kandidaten.forEach(x => {
    if (versteckt.has(x.id)) return;
    if (markers[x.id] && !map.hasLayer(markers[x.id])) markers[x.id].addTo(map);
  });
}

// Zeichnet die Spur eines Trackers neu. Luecken laenger als
// SPUR_GAP_MS trennen die Linie in mehrere Abschnitte - Leaflet nimmt
// dafuer ein Array von Punktlisten, es braucht also keinen zweiten
// Layer.
function zeichneSpur(id) {
  const pts = spurDaten[id];
  if (!trails[id] || !pts || !pts.length) return;

  const segmente = [];
  let seg    = [];
  let letztT = null;
  for (const p of pts) {
    if (letztT !== null && p[0] - letztT > SPUR_GAP_MS) {
      if (seg.length > 1) segmente.push(seg);
      seg = [];
    }
    seg.push([p[1], p[2]]);
    letztT = p[0];
  }
  if (seg.length > 1) segmente.push(seg);
  trails[id].setLatLngs(segmente);
}

// Die Spur kommt vom Server, nicht mehr aus den eigenen Polls. Damit
// ist sie vollstaendig, auch wenn das Handy zwischendurch geschlafen
// hat oder die Seite erst spaet geoeffnet wurde.
async function ladeSpuren() {
  try {
    const url = spurCursor ? `${SERVER}/track?seit=${spurCursor}` : `${SERVER}/track`;
    const res = await fetch(url);
    if (!res.ok) return;
    const d = await res.json();

    // Kleinere Nummer als beim letzten Mal heisst: der Server wurde neu
    // gestartet und zaehlt wieder von vorn. Auf Render passiert das von
    // allein. Ohne diesen Fall haette die Karte auf eine Nummer
    // gewartet, die nie wieder kommt, und die Spur waere stehen
    // geblieben.
    if (typeof d.bis === 'number' && d.bis < spurCursor) {
      Object.keys(spurDaten).forEach(id => delete spurDaten[id]);
      spurCursor = 0;
      const nres = await fetch(`${SERVER}/track`);
      if (!nres.ok) return;
      const nd = await nres.json();
      if (typeof nd.bis === 'number') spurCursor = nd.bis;
      uebernimmSpuren(nd.spuren || {});
      return;
    }
    if (typeof d.bis === 'number') spurCursor = d.bis;

    uebernimmSpuren(d.spuren || {});
  } catch (err) { /* Netz weg - beim naechsten Lauf erneut */ }
}

function uebernimmSpuren(spuren) {
  Object.keys(spuren).forEach(id => {
    const neu = spuren[id];
    if (!Array.isArray(neu) || !neu.length) return;
    if (!spurDaten[id]) spurDaten[id] = [];

    const vorher = spurDaten[id];
    const letzt  = vorher.length ? vorher[vorher.length - 1][0] : null;
    Array.prototype.push.apply(vorher, neu);
    // Nachgelieferte Punkte aus einem Geraetepuffer koennen aelter sein
    // als bereits vorhandene. Nur dann sortieren - im Normalfall haengt
    // der Zuwachs ohnehin hinten an.
    if (letzt !== null && neu[0][0] < letzt) vorher.sort((a, b) => a[0] - b[0]);

    if (vorher.length > TRAIL_MAX_POINTS) {
      spurDaten[id] = vorher.slice(vorher.length - TRAIL_MAX_POINTS);
    }
    zeichneSpur(id);
  });
}

async function loadPositions() {
  try {
    const anfragen = [fetch(`${SERVER}/positions`)];
    if (syncOn) anfragen.push(fetch(`${SERVER}/history?sek=${Math.max(30, syncLagS + 20)}`));
    const [res, hres] = await Promise.all(anfragen);
    const data = await res.json();
    if (hres) {
      try { historyData = await hres.json(); } catch (e) { historyData = {}; }
    } else {
      historyData = {};
    }
    lastPosData = data;
    const ids  = Object.keys(data);

    // Marker wurden angelegt und aktualisiert, aber nie entfernt - und
    // bei einer leeren Antwort brach die Funktion vorher sofort ab.
    // Leerte ein zweites Geraet die Karte oder verwarf der Server alte
    // Positionen beim Rennenwechsel, blieb hier alles stehen, bis
    // jemand die Seite neu laedt. Das Teamauto ist ausgenommen: dessen
    // Marker gehoert dem eigenen Browser, nicht dem Server.
    const bekannt = new Set(ids);
    Object.keys(markers).forEach(id => {
      if (bekannt.has(id)) return;
      if (id === 'TEAMAUTO' && teamCarMarker !== null) return;
      map.removeLayer(markers[id]);
      delete markers[id];
      delete markerRace[id];
      if (trails[id]) { map.removeLayer(trails[id]); delete trails[id]; }
      delete lastPositions[id];
      delete historyData[id];
      delete spurDaten[id];
    });

    if (ids.length === 0) { updateStatus(); return; }

    // Nicht der Zeitpunkt der Antwort zaehlt, sondern die juengste
    // Position darin. Vorher galt jede Antwort als Lebenszeichen -
    // weil der Server Positionen aufhebt, stand die Statuszeile auch
    // Stunden nach dem letzten Tracker-Signal noch auf "Verbunden".
    const newest = ids.reduce((mx, id) => Math.max(mx, data[id].timestamp || 0), 0);
    if (newest > 0) lastDataTime = newest;
    updateStatus();

    const now   = Date.now();
    const zielT = now - syncLagS * 1000;
    const gruppenKandidaten = [];

    // Streckenposition je Tracker, frisch aus /positions. Der Server
    // rechnet sie ohnehin; frueher kam sie nur aus dem Verlauf und
    // damit nur bei eingeschaltetem Zeitabgleich.
    streckenPos = Object.create(null);
    ids.forEach(id => {
      const p = data[id];
      if (p && p.type !== 'betreuer' && typeof p.s === 'number') streckenPos[id] = p.s;
    });

    ids.forEach(id => {
      const pos         = data[id];
      const bat         = pos.bat;
      const displayName = pos.displayName || id;
      const isBetreuer  = pos.type === 'betreuer';
      const anz         = anzeigePosition(id, pos, zielT, isBetreuer);
      const latlng      = [anz.lat, anz.lon];
      const age         = pos.timestamp ? now - pos.timestamp : 0;
      const stale       = !isBetreuer && age > STALE_MS;

      if (id === 'TEAMAUTO' && teamCarMarker !== null) return;

      // Tracker eines abgewaehlten Rennens gehoeren nicht auf die
      // Karte - sonst haette die Auswahl dort kaum Wirkung. Teamauto,
      // Betreuer und Tracker ohne Rennzuordnung bleiben immer
      // sichtbar: sie gehoeren keinem Rennen, das man abwaehlen
      // koennte.
      if (pos.raceId && abgewaehlt.has(pos.raceId)) {
        if (markers[id]) { map.removeLayer(markers[id]); delete markers[id]; }
        if (trails[id])  { map.removeLayer(trails[id]);  delete trails[id]; }
        return;
      }

      if (!trails[id]) {
        const color = id === 'TEAMAUTO' ? '#e53935'
                    : isBetreuer        ? '#ff9800'
                    : (pos.raceColor || '#3388ff');
        trails[id] = L.polyline([], { color, weight: 3, opacity: 0.6 }).addTo(map);
        // Reihenfolge offen: /track kann vor dem ersten /positions
        // geantwortet haben. Dann liegen die Punkte schon bereit und
        // muessen nur noch in die frische Linie.
        zeichneSpur(id);
      }

      if (!markers[id]) {
        const icon = id === 'TEAMAUTO' ? teamCarIcon
                   : isBetreuer        ? betreuerIcon
                   : (pos.raceColor ? rennPin(pos.raceColor) : standardPin());
        if (!isBetreuer && id !== 'TEAMAUTO') markerRace[id] = pos.raceColor || null;

        const label = isBetreuer ? `\u{1F464} ${pos.name || id}` : tooltipContent(displayName, bat, age, pos.avgKmh);

        const marker = L.marker(latlng, { icon }).addTo(map)
          .bindTooltip(label, { permanent: true, direction: 'top' });
        if (stale) marker.setOpacity(0.45);

        if (id !== 'TEAMAUTO' && !isBetreuer) {
          marker.on('contextmenu', e => { L.DomEvent.stop(e); showMarkerMenu(e.originalEvent, id); });
        }

        markers[id] = marker;
        if (!isBetreuer && id !== 'TEAMAUTO') {
          gruppenKandidaten.push({ id, name: displayName, lat: anz.lat, lon: anz.lon, s: anz.s });
        }
        lastPositions[id] = latlng;
        lastPositions[id].bat         = bat;
        lastPositions[id].trackerMode = pos.trackerMode || null;
        lastPositions[id].stale       = stale;
        lastPositions[id].betreuer    = isBetreuer;
        if (firstDevice && !isBetreuer && !stale) {
          if (!startAusschnittGesetzt) { map.setView(latlng, 15); startAusschnittGesetzt = true; }
          firstDevice = false;
        }

      } else {
        if (isBetreuer) {
          markers[id].setLatLng(latlng);
        } else {
          animateMarker(markers[id], lastPositions[id], latlng);
        }

        // Hier wurde bis 1.14.1 die Spur aus den Poll-Punkten
        // aufgebaut. Das ging nur so lange gut, wie die Seite im
        // Vordergrund lief: schlief das Handy, fehlten alle Punkte
        // dazwischen und Leaflet zog eine Gerade darueber. Die Spur
        // kommt jetzt aus ladeSpuren().
        lastPositions[id] = latlng;
        lastPositions[id].bat         = bat;
        lastPositions[id].trackerMode = pos.trackerMode || null;
        lastPositions[id].stale       = stale;
        lastPositions[id].betreuer    = isBetreuer;

        if (!isBetreuer && id !== 'TEAMAUTO') {
          gruppenKandidaten.push({ id, name: displayName, lat: anz.lat, lon: anz.lon, s: anz.s });
        }
        // Unsicher heisst: fuer diesen Zeitpunkt lag kein Punkt vor,
        // gezeigt wird der Rand des Verlaufs. Muss sich von einem
        // frischen Marker unterscheiden.
        if (!isBetreuer) markers[id].setOpacity(stale ? 0.45 : (anz.unsicher ? 0.65 : 1));
        // Die frueher hier stehende Ausnahme fuer TEAMAUTO hat dessen
        // Tooltip nach dem Anlegen nie wieder angefasst: Alter und
        // Akkustand froren auf dem Stand der ersten Meldung ein, nur
        // die Deckkraft ging leise auf 0.45.
        if (!isBetreuer) {
          markers[id].setTooltipContent(tooltipContent(displayName, bat, age, pos.avgKmh));
        }
        // Zuordnung kann sich waehrend des Rennens aendern - auch von
        // einem anderen Geraet aus. Der Vergleich in setzeRennFarbe()
        // sorgt dafuer, dass hier im Regelfall nichts passiert.
        if (!isBetreuer && id !== 'TEAMAUTO') setzeRennFarbe(id, pos.raceColor || null);
      }
    });

    zeichneGruppen(gruppenKandidaten);

    if (autoZoom) {
      // Nur frische, echte Tracker bestimmen den Ausschnitt.
      // Betreuer stehen fest an der Verpflegungszone, gern 30 km vom
      // Feld entfernt - sie mit einzurahmen zoomt das Rennen auf einen
      // Punkt zusammen. Dasselbe gilt fuer Marker aus einem frueheren
      // Rennen, die der Server noch vorhaelt.
      const allLatLngs = Object.values(lastPositions)
        .filter(p => !p.betreuer && !p.stale);
      if (teamCarMarker) {
        const tc = teamCarMarker.getLatLng();
        allLatLngs.push([tc.lat, tc.lng]);
      }
      if (allLatLngs.length === 1) {
        map.panTo(allLatLngs[0], { animate: true, duration: 0.5 });
      } else if (allLatLngs.length >= 2) {
        map.fitBounds(allLatLngs, { padding: [50, 50], animate: true, duration: 0.3 });
      }
    }

  } catch (err) { console.error("Fetch Error:", err); }
}

// =======================
// AKTIVES RENNEN BEOBACHTEN
// =======================
// Die Strecke wurde nur beim Seitenstart geholt. Wechselte der SpoLei
// das Rennen, blieb auf allen anderen Geraeten die alte Linie liegen.
// /active ist bewusst winzig - kein Streckenpunkt, keine Startliste -
// und laesst sich deshalb guenstig pollen.
let activeInfo    = { raceId: null };
let lastActiveKey = null;

// =======================
// AUSWAHL DER RENNEN
// =======================
// Der Teamleiter legt zentral fest, WELCHE Rennen laufen. Was davon
// auf diesem Geraet zu sehen ist, entscheidet der Nutzer hier - und
// zwar ausschliesslich hier. Die Auswahl geht nie an den Server: sie
// gehoert dem Geraet, nicht dem Rennen. Zwei Betreuer am selben
// Streckenposten koennen dieselbe Veranstaltung unterschiedlich
// betrachten, ohne sich gegenseitig die Ansicht zu verstellen.
const LS_SICHTBAR = 'lt.sichtbareRennen';
const LS_MEIN     = 'lt.meinRennen';

// Steckbriefe aller laufenden Rennen, aus /active. raceId -> Objekt.
let steckbriefe = Object.create(null);
// Vom Nutzer abgewaehlte Rennen. Bewusst die Abwahl merken, nicht die
// Auswahl: startet ein neues Rennen, ist es dadurch von selbst dabei.
let abgewaehlt  = new Set();
// Rennen, hinter dem der Nutzer selbst herfaehrt. Steuert den Reiter
// der Taktik und die Kilometrierung im Streckeneditor.
let meinRennen  = null;

try {
  const roh = localStorage.getItem(LS_SICHTBAR);
  if (roh) abgewaehlt = new Set(JSON.parse(roh) || []);
  meinRennen = localStorage.getItem(LS_MEIN) || null;
} catch (e) { /* privater Modus oder voller Speicher - dann eben alles sichtbar */ }

function speichereAuswahl() {
  try {
    localStorage.setItem(LS_SICHTBAR, JSON.stringify([...abgewaehlt]));
    if (meinRennen) localStorage.setItem(LS_MEIN, meinRennen);
    else localStorage.removeItem(LS_MEIN);
  } catch (e) { /* nicht schlimm, gilt dann nur fuer diese Sitzung */ }
}

// Die eine Wahrheit darueber, was auf der Karte liegt. gpx.js fragt
// hier nach, statt einen eigenen Stand zu halten.
function sichtbareRennenListe() {
  return Object.keys(steckbriefe).filter(id => !abgewaehlt.has(id));
}

function steckbriefOf(raceId) { return steckbriefe[raceId] || null; }

function meinRaceId() {
  const sicht = sichtbareRennenListe();
  if (meinRennen && sicht.indexOf(meinRennen) !== -1) return meinRennen;
  return sicht[0] || null;
}

function setzeMeinRennen(raceId) {
  meinRennen = raceId || null;
  // Das eigene Rennen ist ab 2.4.0 auch das Rennen, das bearbeitet
  // wird. Ein ausgeblendetes Rennen zu bearbeiten waere widersinnig -
  // die Wahl blendet es deshalb wieder ein.
  if (raceId) abgewaehlt.delete(raceId);
  speichereAuswahl();
  renderRennAuswahl();
  lastActiveKey = null;          // erzwingt Neuzeichnen der Strecken
  if (typeof arbeitsRennenPruefen === 'function') arbeitsRennenPruefen();
  else if (typeof renderStrip === 'function') renderStrip(taktikGroups);
}

function schalteRennSicht(raceId) {
  if (abgewaehlt.has(raceId)) abgewaehlt.delete(raceId);
  else if (sichtbareRennenListe().length > 1) abgewaehlt.add(raceId);
  else return;   // das letzte sichtbare Rennen bleibt sichtbar
  speichereAuswahl();
  renderRennAuswahl();
  lastActiveKey = null;          // erzwingt Neuzeichnen der Strecken
  fetchGpxTrack();
  // Das Ausblenden kann meinRaceId() verschieben (der Rueckfall ist
  // das erste sichtbare Rennen) - dann wechselt auch das
  // Arbeitsrennen.
  if (typeof arbeitsRennenPruefen === 'function') arbeitsRennenPruefen();
  else if (typeof renderStrip === 'function') renderStrip(taktikGroups);
}

// Aus gpx.js nach dem Setzen eines Streckenpunktes.
function setzeSteckbriefMarker(raceId, liste) {
  if (steckbriefe[raceId]) steckbriefe[raceId].marker = liste;
}
function setzeSteckbriefOffset(raceId, offset) {
  if (steckbriefe[raceId]) steckbriefe[raceId].startOffset = offset;
}

// Wie viele Rennen gerade laufen - unabhaengig davon, was auf diesem
// Geraet ausgewaehlt ist. Der Taktik-Streifen braucht die Zahl, um zu
// entscheiden, ob er ueberhaupt sagen muss, wessen Taktik er zeigt.
function laufendeRennen() { return Object.keys(steckbriefe).length; }

// Bis 2.0.0 lagen oben zwei Kaesten uebereinander: die Chipleiste
// (#rennAuswahl) und der Rundenkasten (#raceClock). Beide trugen
// Farbe und Kuerzel desselben Rennens, und die Chipleiste verdeckte
// auf dem Desktop den Optionen-Knopf - sie war breiter als der Platz
// links davon.
//
// Ab 2.1.0 gibt es nur noch die Rennleiste in #raceClock. Diese
// Funktion behaelt ihren Namen, damit alle Aufrufer unveraendert
// bleiben, und zeichnet die Leiste neu.
function renderRennAuswahl() {
  if (typeof updateRaceClock === 'function') updateRaceClock();
}
// trackerId -> Meter auf der Strecke. Grundlage fuer "naechster Punkt".
let streckenPos   = Object.create(null);

// Einmalig beim Seitenstart alle sichtbaren Strecken ins Bild holen.
// Ohne Strecke passiert nichts und der Deutschland-Ausschnitt bleibt
// stehen.
//
// Bewusst nur beim ersten Lauf von loadActiveInfo(): laedt der SpoLei
// spaeter eine Strecke hoch, darf die Karte nicht wegspringen,
// waehrend jemand gerade eine andere Stelle betrachtet.
//
// Nicht angetastet ist der Auto-Zoom: sobald zwei frische Tracker
// melden, rahmt er im Sekundentakt das Feld ein und ueberschreibt
// diesen Ausschnitt. So war es bisher, und im Rennen ist das richtig.
function startAusschnitt() {
  if (startAusschnittGesetzt) return;
  const punkte = [];
  sichtbareRennenListe().forEach(id => {
    const coords = (typeof gpxByRace !== 'undefined') ? gpxByRace[id] : null;
    if (Array.isArray(coords)) coords.forEach(p => punkte.push(p));
  });
  if (punkte.length === 0) return;
  startAusschnittGesetzt = true;
  // Der einmalige Sprung auf den ersten Tracker entfaellt damit: die
  // Strecke umfasst ihn ohnehin, und ein Zoom 15 auf einen einzelnen
  // Fahrer nimmt kurz nach dem Laden die Uebersicht.
  firstDevice = false;
  map.fitBounds(punkte, { padding: [40, 40] });
}

async function loadActiveInfo() {
  try {
    const res  = await fetch(`${SERVER}/active`);
    const data = await res.json();
    activeInfo = data || { raceId: null };
    pruefeVersion(activeInfo.version);
    // Ab 2.0 liefert /active zusaetzlich races[] mit einem Steckbrief
    // je laufendem Rennen. Fehlt das Feld - alter Server, neues
    // Frontend -, wird der Steckbrief des Leitrennens daraus gebaut,
    // damit die Karte trotzdem etwas anzeigt.
    const liste = Array.isArray(activeInfo.races) && activeInfo.races.length
      ? activeInfo.races
      : (activeInfo.raceId ? [activeInfo] : []);
    const vorher = Object.keys(steckbriefe).sort().join(',');
    steckbriefe = Object.create(null);
    liste.forEach(s => { if (s && s.raceId) steckbriefe[s.raceId] = s; });
    // Beendete Rennen aus der Abwahl entfernen, sonst waechst die
    // Liste ueber Wochen mit Karteileichen.
    [...abgewaehlt].forEach(id => { if (!steckbriefe[id]) abgewaehlt.delete(id); });
    if (vorher !== Object.keys(steckbriefe).sort().join(',')) {
      speichereAuswahl();
      renderRennAuswahl();
      // Startet oder endet ein Rennen, kann meinRaceId() auf ein
      // anderes zeigen - das Arbeitsrennen zieht mit.
      if (typeof arbeitsRennenPruefen === 'function') arbeitsRennenPruefen();
    }
    // Auch die Strecke selbst kann sich aendern, ohne dass das Rennen
    // wechselt - deshalb gehoert der Streckenname mit in den Schluessel.
    // startOffset gehoert in den Schluessel: verschiebt ein zweites
    // Geraet den Zielstrich, soll der Marker hier mitwandern.
    // Die Streckenmarker gehoeren mit in den Schluessel: setzt ein
    // zweites Geraet eine Wertung, soll sie hier auftauchen, ohne dass
    // sich Rennen oder Strecke geaendert haben.
    // Ab 2.0 geht der Schluessel ueber alle sichtbaren Rennen: setzt
    // ein zweites Geraet eine Wertung im zweiten Rennen, soll sie hier
    // genauso auftauchen wie im ersten. Die Abwahl gehoert mit hinein,
    // sonst bleibt eine abgeblendete Strecke liegen.
    const key = sichtbareRennenListe().map(id => {
      const s = steckbriefe[id];
      const mk = (s.marker || [])
        .map(m => `${m.id}:${m.typ}:${m.s}:${m.sEnde === undefined || m.sEnde === null ? '' : m.sEnde}`)
        .join(',');
      return `${id}|${s.gpxName || ''}|${s.gpxPoints || 0}|${s.startOffset || 0}|${mk}`;
    }).join('||');
    if (key !== lastActiveKey) {
      const erster = lastActiveKey === null;
      lastActiveKey = key;
      await fetchGpxTrack();
      // Der Zielmarker haengt an startOffset UND an der Strecke - beim
      // Wechsel muss er neu gesetzt werden.
      drawFinishMarker();
      drawRaceMarker();
      if (erster) startAusschnitt();
      if (!erster) showToast('\u{1F5FA} Strecke aktualisiert');
    }
  } catch (err) { console.error('Active:', err); }
}

// =======================
// RENNUHR UND SCHNITT
// =======================
// Sekundengenau ohne Netzverkehr: der Takt laeuft lokal, die Grundlage
// (Startzeit) kommt aus /active, der Schnitt aus /positions.
function raceStartMsClient() {
  if (!activeInfo || !activeInfo.raceId) return null;
  if (activeInfo.actualStart) return { ms: activeInfo.actualStart, echt: true };
  if (activeInfo.startTime) {
    const t = new Date(activeInfo.startTime).getTime();
    if (!isNaN(t) && t <= Date.now()) return { ms: t, echt: false };
  }
  return null;
}

// Schnitt ueber alle Fahrer-Tracker, die aktuell melden. Betreuer und
// Teamauto bleiben draussen - die fahren andere Wege.
function feldSchnitt() {
  const w = Object.values(lastPosData || {})
    .filter(p => p && typeof p.avgKmh === 'number' && p.type !== 'betreuer')
    .map(p => p.avgKmh);
  if (!w.length) return null;
  return Math.round(w.reduce((a, b) => a + b, 0) / w.length * 10) / 10;
}

// Handkorrektur des Rundenzaehlers. Die Automatik rechnet danach vom
// korrigierten Stand weiter.
async function adjustLap(delta, raceId) {
  // Ab 2.0 wird die Renn-ID mitgegeben: der Knopf gehoert zu genau der
  // Zeile, in der er steht.
  const ziel = raceId || (activeInfo && activeInfo.raceId);
  if (!ziel || !authToken) return;
  try {
    const res = await fetch(`${SERVER}/races/${ziel}/lap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ delta })
    });
    if (!res.ok) { checkAuth(res); showToast('\u26A0\uFE0F Runde nicht ge\u00E4ndert'); return; }
    const d = await res.json();
    // Der Rundenstand gehoert dem Rennen. Bis 1.19.0 gab es nur eines,
    // deshalb stand er direkt in activeInfo.
    if (steckbriefe[ziel]) {
      steckbriefe[ziel].currentLap = d.currentLap;
      steckbriefe[ziel].finalLap   = d.finalLap;
    }
    if (activeInfo && activeInfo.raceId === ziel) {
      activeInfo.currentLap = d.currentLap;
      activeInfo.finalLap   = d.finalLap;
    }
    updateRaceClock();
  } catch (e) { showToast('\u26A0\uFE0F ' + e.message); }
}

// Der naechste Streckenpunkt vor dem Feld. Bezugspunkt ist die Spitze,
// gemessen ab Start/Ziel.
//
// Der Sonderfall am Zielstrich ist der wichtige: hat die Spitze gerade
// ueberquert (relativ ~0) und das Gruppetto noch nicht (relativ ~L),
// waere der hinterste der "weiteste". Deshalb zaehlt dann nur, wer
// schon durch ist.
function naechsterPunkt() {
  if (!activeInfo || !activeInfo.raceId) return null;
  const liste = Array.isArray(activeInfo.marker) ? activeInfo.marker : [];
  const L = activeInfo.trackLength;
  if (!liste.length || !L) return null;

  const off = activeInfo.startOffset || 0;
  const rel = x => (((x - off) % L) + L) % L;

  const werte = Object.values(streckenPos).map(rel);
  if (!werte.length) return null;
  const vorn   = werte.filter(r => r < 0.10 * L);
  const hinten = werte.filter(r => r > 0.90 * L);
  const anker  = (vorn.length && hinten.length) ? Math.max(...vorn) : Math.max(...werte);

  const runde = activeInfo.currentLap || 1;
  let best = null;
  for (const m of liste) {
    if (!m || typeof m.s !== 'number') continue;
    if (m.typ === 'start') continue;                    // sagt im Rennen nichts
    if (Array.isArray(m.runden) && m.runden.length && !m.runden.includes(runde)) continue;
    const d = (((rel(m.s) - anker) % L) + L) % L;
    if (best === null || d < best.d) best = { d, m };
  }
  return best;
}

function naechsterPunktText() {
  const b = naechsterPunkt();
  if (!b) return '';
  const a = (typeof markerArt === 'function') ? markerArt(b.m.typ) : { icon: '\u{1F4CC}', label: 'Punkt' };
  const was = b.m.name || a.label;
  const wo  = b.d < 50   ? 'jetzt'
            : b.d < 1000 ? `in ${Math.round(b.d / 10) * 10} m`
            :              `in ${(b.d / 1000).toFixed(1).replace('.', ',')} km`;
  return `<span class="rcNext">${a.icon} ${escNext(was)} ${wo}</span>`;
}

// Marker-Namen sind frei eingegeben und landen hier in innerHTML.
function escNext(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Eine Zeile der Rennleiste: Farbpunkt, Kuerzel, Rundenstand und die
// Korrekturknoepfe. Die Knoepfe tragen die Renn-ID mit sich - bei zwei
// Rennen darf kein Zweifel bestehen, welche Zaehlung ein Tipp
// verstellt.
//
// Ab 2.1.0 ist die Zeile zugleich die Auswahl: tippen blendet das
// Rennen aus und wieder ein, langes Tippen setzt das eigene Rennen.
// Ein abgewaehltes Rennen behaelt seine Zeile - sonst gaebe es keinen
// Weg zurueck.
//
// mehrere: erst ab zwei laufenden Rennen gibt es etwas zu waehlen. Bei
// einem bleibt die Zeile ein reiner Rundenstand, wie bis 2.0.0.
function rennZeile(raceId, mehrere) {
  const s = steckbriefe[raceId];
  if (!s) return '';
  // Ohne Veranstaltungsnamen: der ist bei allen gleichzeitig laufenden
  // Rennen derselbe und kostet auf einem Handydisplay die halbe Zeile.
  const lbl = s.name || raceId;
  const an  = !abgewaehlt.has(raceId);
  const ich = mehrere && an && raceId === meinRaceId();
  let txt;
  if (!s.currentLap)      txt = '\u2013';
  else if (s.finalLap)    txt = '\u{1F3C1} Zielrunde';
  else if (s.laps && s.laps - s.currentLap === 1) txt = 'Noch 1 Runde';
  else if (s.laps)        txt = `Noch ${s.laps - s.currentLap} Runden`;
  else                    txt = `Runde ${s.currentLap}`;
  // Kein Rundenzaehler fuer ein ausgeblendetes Rennen: die Zeile ist
  // dann nur noch der Weg zurueck, kein Bedienelement.
  const darf  = an && authLevel === 'spolei';
  const minus = darf ? `<button class="rcLap" data-lap="-1" data-race="${raceId}" title="Runde zur\u00FCck">\u2212</button>` : '';
  const plus  = darf ? `<button class="rcLap" data-lap="1" data-race="${raceId}" title="Runde weiter">+</button>` : '';
  const rechts = an
    ? `<span class="rcLapBox${s.finalLap ? ' final' : ''}">${minus}`
      + `<span class="rcLapTxt">${txt}</span>${plus}</span>`
    : '<span class="rcAus">ausgeblendet</span>';
  return `<span class="rcRow${an ? '' : ' aus'}${mehrere ? ' waehlbar' : ''}" data-race="${raceId}">`
       + `<span class="rcD" style="background:${s.farbe || '#607d8b'}"></span>`
       + `<span class="rcN">${escH(lbl)}</span>`
       + (ich ? '<span class="rcMe">\u{1F697}</span>' : '')
       + rechts + '</span>';
}

// Die Knoepfe der Rennleiste anschliessen. Der Tipp auf einen
// Rundenknopf darf nicht bis zur Zeile durchschlagen - sonst wuerde
// eine Rundenkorrektur das Rennen gleich mit ausblenden.
function bindeRennLeiste(el, mehrere) {
  el.querySelectorAll('.rcLap').forEach(b => {
    b.addEventListener('click', ev => {
      ev.stopPropagation();
      adjustLap(Number(b.dataset.lap), b.dataset.race);
    });
  });
  if (!mehrere) return;
  el.querySelectorAll('.rcRow.waehlbar').forEach(row => {
    let lang = null;
    const setzen = () => {
      if (!abgewaehlt.has(row.dataset.race)) setzeMeinRennen(row.dataset.race);
    };
    row.addEventListener('click', () => {
      if (lang === 'fertig') { lang = null; return; }
      schalteRennSicht(row.dataset.race);
    });
    row.addEventListener('contextmenu', e => { e.preventDefault(); setzen(); });
    row.addEventListener('touchstart', () => {
      lang = setTimeout(() => { lang = 'fertig'; setzen(); }, 550);
    }, { passive: true });
    row.addEventListener('touchend', () => {
      if (lang && lang !== 'fertig') { clearTimeout(lang); lang = null; }
    });
  });
}

// Zuletzt gezeichnete Leiste. updateRaceClock() laeuft im
// Sekundentakt; ein Neuaufbau mitten im langen Tippen wuerde das
// Element samt Timer wegwerfen und die Auswahl des eigenen Rennens
// waere Gluecksache.
let letzteLeiste = null;

function updateRaceClock() {
  const el = document.getElementById('raceClock');
  if (!el) return;
  // Ab 2.1.0 steht die Rennleiste VOR der Startzeitpruefung. Bis 2.0.0
  // hing sie an raceStartMsClient(): ein Rennen ohne bestaetigten oder
  // geplanten Start hatte keine Leiste - und damit auch keine
  // Rennauswahl, obwohl die Rennen liefen.
  //
  // Gezeigt werden ALLE laufenden Rennen, auch die abgewaehlten: die
  // Zeile ist der einzige Weg, ein ausgeblendetes Rennen
  // zurueckzuholen.
  const ids = Object.keys(steckbriefe);
  if (ids.length) {
    const mehrere = ids.length > 1;
    const html = ids.map(id => rennZeile(id, mehrere)).join('');
    if (html !== letzteLeiste) {
      letzteLeiste = html;
      el.innerHTML = html;
      bindeRennLeiste(el, mehrere);
    }
    el.classList.remove('hidden', 'geplant');
    el.classList.add('rennliste');
    el.title = mehrere
      ? 'Tippen blendet ein und aus \u2013 langes Tippen setzt das eigene Rennen'
      : 'Runde \u2013 \u00B1 korrigiert die Z\u00E4hlung';
    return;
  }
  letzteLeiste = null;
  el.classList.remove('rennliste');
  const s = raceStartMsClient();
  if (!s) { el.classList.add('hidden'); return; }
  const sek = Math.max(0, Math.floor((Date.now() - s.ms) / 1000));
  const zeit = `${Math.floor(sek / 3600)}:${String(Math.floor(sek / 60) % 60).padStart(2, '0')}`
             + `:${String(sek % 60).padStart(2, '0')}`;
  const avg = feldSchnitt();
  // Zielrunde statt "4/4": im Auto zaehlt die Aussage, nicht die Zahl.
  let runde = '';
  if (activeInfo.currentLap) {
    // Herunterzaehlen wie die Tafel am Zielstrich: im Auto zaehlt die
    // verbleibende Arbeit, nicht die geleistete. Ohne Sollrunden bleibt
    // nur das Hochzaehlen uebrig.
    let txt;
    if (activeInfo.finalLap)      txt = '\u{1F3C1} Zielrunde';
    else if (activeInfo.laps)     txt = `Noch ${activeInfo.laps - activeInfo.currentLap} Runden`;
    else                          txt = `Runde ${activeInfo.currentLap}`;
    if (activeInfo.laps && activeInfo.laps - activeInfo.currentLap === 1) txt = 'Noch 1 Runde';
    const darf   = authLevel === 'spolei';
    const minus  = darf ? '<button class="rcLap" data-lap="-1" title="Runde zur\u00FCck">\u2212</button>' : '';
    const plus   = darf ? '<button class="rcLap" data-lap="1" title="Runde weiter">+</button>' : '';
    runde = `<span class="rcLapBox${activeInfo.finalLap ? ' final' : ''}">`
          + minus + `<span class="rcLapTxt">${txt}</span>` + plus + '</span>';
  }
  el.innerHTML = `\u23F1 ${zeit}`
    + runde
    + (avg !== null ? `<span class="rcAvg">\u00D8 ${avg.toFixed(1).replace('.', ',')} km/h</span>` : '')
    + naechsterPunktText();
  el.querySelectorAll('.rcLap').forEach(b => {
    b.addEventListener('click', ev => {
      ev.stopPropagation();
      adjustLap(Number(b.dataset.lap));
    });
  });
  // Grau, solange der Startschuss nicht bestaetigt ist: dann laeuft die
  // Uhr auf den geplanten Termin und stimmt vermutlich nicht.
  el.classList.toggle('geplant', !s.echt);
  el.title = s.echt ? 'Fahrtzeit seit Startschuss' : 'Nach geplantem Start \u2013 \u201EStart jetzt\u201C im Rennen-Panel';
  el.classList.remove('hidden');
}

// =======================
// LOAD PENDING (Tracker ohne Fix)
// Eigener Endpoint, eigener Takt: der Heartbeat kommt nur alle
// 10 s, 3 s Polling reichen voellig.
// =======================
async function loadPending() {
  try {
    const res  = await fetch(`${SERVER}/pending`);
    const data = await res.json();
    const next = Array.isArray(data.pending) ? data.pending : [];

    const before = pendingTrackers.map(p => p.id).join(',');
    const after  = next.map(p => p.id).join(',');
    pendingTrackers = next;

    // Nur wenn sonst nichts reinkommt, gilt ein Suchender als
    // Lebenszeichen. Sonst wuerde ein suchender Tracker die
    // Offline-Erkennung eines fahrenden Trackers ueberdecken.
    if (next.length > 0 && Object.keys(lastPositions).length === 0) {
      lastDataTime = Date.now();
    }
    updateStatus();

    // Taktik nur bei echter Aenderung neu zeichnen - und nie,
    // waehrend jemand gerade in ein Nachrichtenfeld tippt.
    if (taktikOpen && before !== after) {
      const el = document.activeElement;
      if (!el || !el.classList || !el.classList.contains('disp-inp')) renderTaktikBody();
    }
  } catch (err) { console.error('Pending:', err); }
}

// =======================
// RESET
// =======================
async function clearMap() {
  // Die Rueckfrage laeuft ueber #confirmClearModal (eigener Dialog, mittig).
  // Ein zusaetzlicher System-Dialog waere eine Bestaetigung zu viel.
  try {
    const res = await fetch(`${SERVER}/positions`, {
      method: 'DELETE', headers: { 'Authorization': `Bearer ${authToken}` }
    });
    // Ohne diese Pruefung sah ein Leeren mit abgelaufener Sitzung
    // erfolgreich aus: die Marker verschwanden lokal und kamen beim
    // naechsten Poll alle zurueck.
    if (!res.ok) {
      checkAuth(res);
      showToast('\u26A0\uFE0F Karte konnte nicht geleert werden');
      return;
    }
    Object.keys(markers).forEach(id => { map.removeLayer(markers[id]); delete markers[id]; });
    Object.keys(trails).forEach(id  => { map.removeLayer(trails[id]);  delete trails[id];  });
    Object.keys(lastPositions).forEach(id => delete lastPositions[id]);
    // Der Server hat die aufgezeichneten Spuren mitgeloescht. Der
    // Cursor muss zurueck auf null, sonst fragt die Karte nur noch nach
    // Punkten "seit" einem Zeitpunkt, zu dem es nichts mehr gibt.
    Object.keys(spurDaten).forEach(id => delete spurDaten[id]);
    spurCursor = 0;
    lastDataTime = null; firstDevice = true; updateStatus();
  } catch (err) { alert('\u274C Fehler: ' + err.message); }
}
// Die Bestaetigung sitzt bewusst nicht mehr an der Stelle des Ausloesers,
// sondern in einem eigenen Fenster mittig im Bild. Zusaetzlich ist der rote
// Knopf die ersten CLEAR_ARM_MS gesperrt, damit ein reflexhafter Doppeltipp
// oder ein Verwackeln im Auto nicht loeschen kann.
const resetBtn          = document.getElementById('resetBtn');
const confirmClearModal = document.getElementById('confirmClearModal');
const ccConfirmBtn      = document.getElementById('ccConfirmBtn');
const ccCancelBtn       = document.getElementById('ccCancelBtn');

const CLEAR_ARM_MS = 800;   // muss zur Dauer von @keyframes ccArm passen
let clearArmTimer = null;

function openClearConfirm() {
  if (clearArmTimer) clearTimeout(clearArmTimer);
  ccConfirmBtn.disabled = true;
  confirmClearModal.classList.remove('hidden');
  confirmClearModal.classList.remove('armed');
  // Reflow erzwingen, sonst startet der Balken beim zweiten Oeffnen nicht neu
  void confirmClearModal.offsetWidth;
  confirmClearModal.classList.add('arming');
  ccCancelBtn.focus();
  clearArmTimer = setTimeout(() => {
    confirmClearModal.classList.remove('arming');
    confirmClearModal.classList.add('armed');
    ccConfirmBtn.disabled = false;
    clearArmTimer = null;
  }, CLEAR_ARM_MS);
}

function closeClearConfirm() {
  if (clearArmTimer) { clearTimeout(clearArmTimer); clearArmTimer = null; }
  confirmClearModal.classList.add('hidden');
  confirmClearModal.classList.remove('arming');
  confirmClearModal.classList.remove('armed');
  ccConfirmBtn.disabled = true;
}

resetBtn.addEventListener('click', openClearConfirm);
ccCancelBtn.addEventListener('click', closeClearConfirm);
document.getElementById('ccScrim').addEventListener('click', closeClearConfirm);

ccConfirmBtn.addEventListener('click', () => {
  if (ccConfirmBtn.disabled) return;
  closeClearConfirm();
  closeAdvanced();   // Sheet zu, damit der rote Knopf nicht offen stehen bleibt
  clearMap();
});

// ESC schliesst zuerst diesen Dialog. core/ui.js prueft das und laesst
// das Sheet in dem Fall stehen.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!confirmClearModal.classList.contains('hidden')) closeClearConfirm();
});

