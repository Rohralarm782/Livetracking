// =======================
// MAP
// =======================
const map = L.map('map').setView([52.52, 13.405], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

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
        await fetch('https://livetracking-fq4l.onrender.com/team-position', {
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
  if (ago >= 5) {
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

function tooltipContent(id, bat) {
  return id + batLabel(bat);
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
      const res = await fetch('https://livetracking-fq4l.onrender.com/rename-tracker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ trackerId: markerId, newName })
      });
      if (!res.ok) { alert('\u274C Fehler beim Umbenennen'); return; }
      if (markers[markerId]) {
        markers[newName] = markers[markerId]; delete markers[markerId];
        if (lastPositions[markerId]) { lastPositions[newName] = lastPositions[markerId]; delete lastPositions[markerId]; }
        if (trails[markerId])        { trails[newName] = trails[markerId]; delete trails[markerId]; }
        markers[newName].setTooltipContent(newName);
      }
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

    lastDataTime = Date.now();
    updateStatus();

    ids.forEach(id => {
      const pos         = data[id];
      const latlng      = [pos.lat, pos.lon];
      const bat         = pos.bat;
      const displayName = pos.displayName || id;
      const isBetreuer  = pos.type === 'betreuer';

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
                       iconUrl: 'https://unpkg.com/leaflet/dist/images/marker-icon.png',
                       shadowUrl: 'https://unpkg.com/leaflet/dist/images/marker-shadow.png',
                       iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
                     });

        const label = isBetreuer ? `\u{1F464} ${pos.name || id}` : tooltipContent(displayName, bat);

        const marker = L.marker(latlng, { icon }).addTo(map)
          .bindTooltip(label, { permanent: true, direction: 'top' });

        if (id !== 'TEAMAUTO' && !isBetreuer) {
          marker.on('contextmenu', e => { L.DomEvent.stop(e); showMarkerMenu(e.originalEvent, id); });
        }

        markers[id] = marker;
        lastPositions[id] = latlng;
        lastPositions[id].bat         = bat;
        lastPositions[id].trackerMode = pos.trackerMode || null;
        if (firstDevice && !isBetreuer) { map.setView(latlng, 15); firstDevice = false; }

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

        if (!isBetreuer && id !== 'TEAMAUTO') {
          markers[id].setTooltipContent(tooltipContent(displayName, bat));
        }
      }
    });

    if (autoZoom) {
      const allLatLngs = Object.values(lastPositions);
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
  if (!confirm('\u{1F6A8} Wirklich ALLE Positionen l\u00F6schen?')) return;
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
document.getElementById("resetBtn").addEventListener("click", clearMap);

