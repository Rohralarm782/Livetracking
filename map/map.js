// =======================
// MAP
// =======================
const map = L.map('map').setView([52.52, 13.405], 13);

// Zwei Kartenstile zur Auswahl. Voyager ist die Vorgabe: entsaettigt,
// wenig Beschriftung, kaum Symbole - die orange Streckenlinie und die
// Marker liegen praktisch allein auf grauem Grund. Auf dem
// OSM-Standard konkurriert dieselbe Linie mit orangen Autobahnen und
// gelben Landstrassen, und im fahrenden Auto entscheidet das darueber,
// ob man den Verlauf in zwei Sekunden erfasst oder suchen muss.
// OSM-Standard bleibt waehlbar: er beschriftet mehr und hilft in duenn
// besiedelten Gegenden bei der Orientierung.
const TILE_STYLES = {
  voyager: {
    label: 'Voyager',
    url:   'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    opts:  { maxZoom: 20, subdomains: 'abcd',
             attribution: '&copy; OpenStreetMap, &copy; CARTO' }
  },
  osm: {
    label: 'OSM',
    url:   'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    opts:  { maxZoom: 19, subdomains: 'abc',
             attribution: '&copy; OpenStreetMap' }
  }
};

let tileStyle = localStorage.getItem('tileStyle') === 'osm' ? 'osm' : 'voyager';
let tileLayer = null;

function applyTileStyle(key) {
  const def = TILE_STYLES[key] || TILE_STYLES.voyager;
  tileStyle = TILE_STYLES[key] ? key : 'voyager';
  if (tileLayer) map.removeLayer(tileLayer);
  // Ganz nach unten: sonst liegen die frischen Kacheln ueber Strecke,
  // Spuren und Markern.
  tileLayer = L.tileLayer(def.url, def.opts).addTo(map);
  tileLayer.bringToBack();
  const seg = document.getElementById('mapStyleSeg');
  if (seg) seg.querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.style === tileStyle);
  });
  localStorage.setItem('tileStyle', tileStyle);
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
const lastPositions = {};
const trails        = {};
let currentMarkerMenu = null;
let firstDevice  = true;
let lastDataTime = null;
let autoZoom     = true;
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
    delete lastPositions[markerId];
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

  container.appendChild(input);
  container.appendChild(renameBtn);
  container.appendChild(delBtn);
  document.body.appendChild(container);
  currentMarkerMenu = container;
  input.focus(); input.select();
}

// =======================
// AUTO-ZOOM TOGGLE
// =======================
document.getElementById('autoZoomBtn').addEventListener('click', () => {
  autoZoom = !autoZoom;
  const btn = document.getElementById('autoZoomBtn');
  btn.textContent = autoZoom ? '\u{1F3AF} Auto-Zoom: Ein' : '\u{1F3AF} Auto-Zoom: Aus';
  btn.classList.toggle('active', autoZoom);
});

// =======================
// LOAD POSITIONS
// =======================
async function loadPositions() {
  try {
    const res  = await fetch(`${SERVER}/positions`);
    const data = await res.json();
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
      if (trails[id]) { map.removeLayer(trails[id]); delete trails[id]; }
      delete lastPositions[id];
    });

    if (ids.length === 0) { updateStatus(); return; }

    // Nicht der Zeitpunkt der Antwort zaehlt, sondern die juengste
    // Position darin. Vorher galt jede Antwort als Lebenszeichen -
    // weil der Server Positionen aufhebt, stand die Statuszeile auch
    // Stunden nach dem letzten Tracker-Signal noch auf "Verbunden".
    const newest = ids.reduce((mx, id) => Math.max(mx, data[id].timestamp || 0), 0);
    if (newest > 0) lastDataTime = newest;
    updateStatus();

    const now = Date.now();

    ids.forEach(id => {
      const pos         = data[id];
      const latlng      = [pos.lat, pos.lon];
      const bat         = pos.bat;
      const displayName = pos.displayName || id;
      const isBetreuer  = pos.type === 'betreuer';
      const age         = pos.timestamp ? now - pos.timestamp : 0;
      const stale       = !isBetreuer && age > STALE_MS;

      if (id === 'TEAMAUTO' && teamCarMarker !== null) return;

      if (!trails[id]) {
        const color = id === 'TEAMAUTO' ? '#e53935'
                    : isBetreuer        ? '#ff9800'
                    : '#3388ff';
        trails[id] = L.polyline([], { color, weight: 3, opacity: 0.6 }).addTo(map);
      }

      if (!markers[id]) {
        const icon = id === 'TEAMAUTO' ? teamCarIcon
                   : isBetreuer        ? betreuerIcon
                   : L.icon({
                       iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
                       shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
                       iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
                     });

        const label = isBetreuer ? `\u{1F464} ${pos.name || id}` : tooltipContent(displayName, bat, age, pos.avgKmh);

        const marker = L.marker(latlng, { icon }).addTo(map)
          .bindTooltip(label, { permanent: true, direction: 'top' });
        if (stale) marker.setOpacity(0.45);

        if (id !== 'TEAMAUTO' && !isBetreuer) {
          marker.on('contextmenu', e => { L.DomEvent.stop(e); showMarkerMenu(e.originalEvent, id); });
        }

        markers[id] = marker;
        lastPositions[id] = latlng;
        lastPositions[id].bat         = bat;
        lastPositions[id].trackerMode = pos.trackerMode || null;
        lastPositions[id].stale       = stale;
        lastPositions[id].betreuer    = isBetreuer;
        if (firstDevice && !isBetreuer && !stale) { map.setView(latlng, 15); firstDevice = false; }

      } else {
        if (isBetreuer) {
          markers[id].setLatLng(latlng);
        } else {
          animateMarker(markers[id], lastPositions[id], latlng);
        }

        const prev  = lastPositions[id];
        const moved = Math.abs(prev[0] - latlng[0]) > 0.000005 || Math.abs(prev[1] - latlng[1]) > 0.000005;
        if (moved && !isBetreuer) {
          trails[id].addLatLng(latlng);
          // Im Renn-Modus meldet ein fahrender Tracker alle 2 s. Ueber
          // drei Stunden waeren das gut 5000 Punkte je Spur, die Leaflet
          // bei jedem Verschieben neu zeichnet. TRAIL_MAX_POINTS deckt
          // rund die letzte Stunde ab, das reicht zum Nachvollziehen.
          const pts = trails[id].getLatLngs();
          if (pts.length > TRAIL_MAX_POINTS) {
            trails[id].setLatLngs(pts.slice(pts.length - TRAIL_MAX_POINTS));
          }
        }
        lastPositions[id] = latlng;
        lastPositions[id].bat         = bat;
        lastPositions[id].trackerMode = pos.trackerMode || null;
        lastPositions[id].stale       = stale;
        lastPositions[id].betreuer    = isBetreuer;

        if (!isBetreuer) markers[id].setOpacity(stale ? 0.45 : 1);
        // Die frueher hier stehende Ausnahme fuer TEAMAUTO hat dessen
        // Tooltip nach dem Anlegen nie wieder angefasst: Alter und
        // Akkustand froren auf dem Stand der ersten Meldung ein, nur
        // die Deckkraft ging leise auf 0.45.
        if (!isBetreuer) {
          markers[id].setTooltipContent(tooltipContent(displayName, bat, age, pos.avgKmh));
        }
      }
    });

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

async function loadActiveInfo() {
  try {
    const res  = await fetch(`${SERVER}/active`);
    const data = await res.json();
    activeInfo = data || { raceId: null };
    // Auch die Strecke selbst kann sich aendern, ohne dass das Rennen
    // wechselt - deshalb gehoert der Streckenname mit in den Schluessel.
    const key = `${activeInfo.raceId || ''}|${activeInfo.gpxName || ''}|${activeInfo.gpxPoints || 0}`;
    if (key !== lastActiveKey) {
      const erster = lastActiveKey === null;
      lastActiveKey = key;
      await fetchGpxTrack();
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
async function adjustLap(delta) {
  if (!activeInfo || !activeInfo.raceId || !authToken) return;
  try {
    const res = await fetch(`${SERVER}/races/${activeInfo.raceId}/lap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ delta })
    });
    if (!res.ok) { checkAuth(res); showToast('\u26A0\uFE0F Runde nicht ge\u00E4ndert'); return; }
    const d = await res.json();
    activeInfo.currentLap = d.currentLap;
    activeInfo.finalLap   = d.finalLap;
    updateRaceClock();
  } catch (e) { showToast('\u26A0\uFE0F ' + e.message); }
}

function updateRaceClock() {
  const el = document.getElementById('raceClock');
  if (!el) return;
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
    + (avg !== null ? `<span class="rcAvg">\u00D8 ${avg.toFixed(1).replace('.', ',')} km/h</span>` : '');
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

