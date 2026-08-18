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

function tooltipContent(id, bat, age) {
  const old = (typeof age === 'number' && age > STALE_MS)
    ? ` <span style="color:#c62828;font-size:11px">\u23F8 ${ageLabel(age)}</span>`
    : '';
  return id + batLabel(bat) + old;
}

// =======================
// CONTEXT MENU
// =======================
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

  container.appendChild(input);
  container.appendChild(renameBtn);
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
    if (ids.length === 0) return;

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

        const label = isBetreuer ? `\u{1F464} ${pos.name || id}` : tooltipContent(displayName, bat, age);

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
        if (moved && !isBetreuer) trails[id].addLatLng(latlng);
        lastPositions[id] = latlng;
        lastPositions[id].bat         = bat;
        lastPositions[id].trackerMode = pos.trackerMode || null;
        lastPositions[id].stale       = stale;
        lastPositions[id].betreuer    = isBetreuer;

        if (!isBetreuer) markers[id].setOpacity(stale ? 0.45 : 1);
        if (!isBetreuer && id !== 'TEAMAUTO') {
          markers[id].setTooltipContent(tooltipContent(displayName, bat, age));
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
  // Die Rueckfrage steht als zweistufiger Knopf im Einstellungs-Sheet,
  // ein zusaetzlicher System-Dialog waere eine Bestaetigung zu viel.
  try {
    await fetch(`${SERVER}/positions`, {
      method: 'DELETE', headers: { 'Authorization': `Bearer ${authToken}` }
    });
    Object.keys(markers).forEach(id => { map.removeLayer(markers[id]); delete markers[id]; });
    Object.keys(trails).forEach(id  => { map.removeLayer(trails[id]);  delete trails[id];  });
    Object.keys(lastPositions).forEach(id => delete lastPositions[id]);
    lastDataTime = null; firstDevice = true; updateStatus();
  } catch (err) { alert('\u274C Fehler: ' + err.message); }
}
const resetBtn     = document.getElementById('resetBtn');
const resetConfirm = document.getElementById('resetConfirm');

function hideResetConfirm() {
  resetConfirm.classList.add('hidden');
  resetBtn.classList.remove('hidden');
}

resetBtn.addEventListener('click', () => {
  resetBtn.classList.add('hidden');
  resetConfirm.classList.remove('hidden');
});
document.getElementById('resetCancelBtn').addEventListener('click', hideResetConfirm);
document.getElementById('resetConfirmBtn').addEventListener('click', () => {
  hideResetConfirm();
  clearMap();
});

