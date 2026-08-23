// =======================
// GPX TRACKS
// =======================
// Die Strecke gehoert zum Rennen und wird in der Rennverwaltung
// hochgeladen. /gpx liefert immer die Strecke des AKTIVEN Rennens,
// deshalb muss die Linie beim Rennenwechsel neu geholt werden.
let gpxLayer = null;
// Die Punkte werden fuer den Zielmarker und den Streckenmodus gebraucht:
// daraus laesst sich jede Position auf der Runde in Grad umrechnen, ohne
// den Server zu fragen.
let gpxCoords = [];

async function fetchGpxTrack() {
  try {
    const res  = await fetch(`${SERVER}/gpx`);
    const data = await res.json();
    if (data && data.coords && data.coords.length > 0) drawGpxLayer(data.coords);
    else clearGpxLayer();
  } catch (err) { console.error('GPX fetch:', err); }
}

function drawGpxLayer(coords) {
  if (gpxLayer) { map.removeLayer(gpxLayer); gpxLayer = null; }
  gpxCoords = coords;
  gpxLayer = L.polyline(coords, {
    color: '#e65100', weight: 4, opacity: 0.8, lineJoin: 'round', lineCap: 'round'
  }).addTo(map);
  // Im Streckenmodus faengt eine unsichtbare, breitere Linie die Tipper:
  // die 4 px der Streckenlinie waeren im fahrenden Auto nicht zu treffen.
  gpxLayer.on('click', onTrackClick);
  drawFinishMarker();
}

function clearGpxLayer() {
  if (gpxLayer) { map.removeLayer(gpxLayer); gpxLayer = null; }
  gpxCoords = [];
  drawFinishMarker();
}

// Abstand zweier Koordinaten in Metern. Gleiche Formel wie im Server,
// damit Kilometrierung hier und dort denselben Wert ergibt.
function distMeters(aLat, aLon, bLat, bLon) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const s = Math.sin(dLat / 2) ** 2
          + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Aufsummierte Distanz je Punkt, gleiche Rechnung wie im Server.
function gpxCumulative() {
  const cum = [0];
  for (let i = 1; i < gpxCoords.length; i++) {
    cum[i] = cum[i - 1] + distMeters(
      gpxCoords[i - 1][0], gpxCoords[i - 1][1], gpxCoords[i][0], gpxCoords[i][1]);
  }
  return cum;
}

// Position auf der Runde (Meter) -> [lat, lon]
function gpxPointAt(meter) {
  if (gpxCoords.length < 2) return null;
  const cum = gpxCumulative();
  const L   = cum[cum.length - 1];
  if (!L) return null;
  const s = ((meter % L) + L) % L;
  let i = 1;
  while (i < cum.length && cum[i] < s) i++;
  const f = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
  return [gpxCoords[i - 1][0] + (gpxCoords[i][0] - gpxCoords[i - 1][0]) * f,
          gpxCoords[i - 1][1] + (gpxCoords[i][1] - gpxCoords[i - 1][1]) * f];
}

// =======================
// ZIELMARKER UND STRECKENMODUS
// =======================
let finishMarker = null;
let streckenModus = false;

const finishIcon = L.divIcon({
  className: '', iconSize: [26, 26], iconAnchor: [13, 13],
  html: '<div style="font-size:19px;line-height:26px;text-align:center;'
      + 'filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">\u{1F3C1}</div>'
});

// Zeichnet Start/Ziel dort, wo der Server es fuehrt. Die Umrechnung von
// Metern in Grad passiert hier, damit der Marker auch dann steht, wenn
// gerade keine Position hereinkommt.
function drawFinishMarker() {
  if (finishMarker) { map.removeLayer(finishMarker); finishMarker = null; }
  if (!activeInfo || !activeInfo.raceId || gpxCoords.length < 2) return;
  const p = gpxPointAt(activeInfo.startOffset || 0);
  if (!p) return;
  finishMarker = L.marker(p, { icon: finishIcon, interactive: false })
    .addTo(map)
    .bindTooltip('\u{1F3C1} Start / Ziel', { permanent: false, direction: 'top' });
}

function setStreckenModus(an) {
  streckenModus = !!an && authLevel === 'spolei';
  document.getElementById('streckenBar').classList.toggle('hidden', !streckenModus);
  if (gpxLayer) {
    gpxLayer.setStyle(streckenModus
      ? { color: '#1565c0', weight: 8, opacity: 0.95 }
      : { color: '#e65100', weight: 4, opacity: 0.8 });
  }
  const el = document.getElementById('map');
  if (el) el.style.cursor = streckenModus ? 'crosshair' : '';
  if (streckenModus) zeigeZielKm();
}

function zeigeZielKm() {
  const el = document.getElementById('streckenKm');
  if (!el || !activeInfo) return;
  el.value = ((activeInfo.startOffset || 0) / 1000).toFixed(2).replace('.', ',');
}

// Tipp auf die Strecke: der Server projiziert die Koordinate mit
// derselben Rechnung wie eine GPS-Meldung.
async function onTrackClick(e) {
  if (!streckenModus || !activeInfo || !activeInfo.raceId) return;
  L.DomEvent.stop(e);
  await sendeZiel({ atLat: e.latlng.lat, atLon: e.latlng.lng });
}

async function sendeZiel(felder) {
  try {
    const d = await setRaceLaps(activeInfo.raceId, felder);
    activeInfo.startOffset = d.startOffset;
    drawFinishMarker();
    zeigeZielKm();
    showToast(`\u{1F3C1} Start/Ziel bei km ${(d.startOffset / 1000).toFixed(2).replace('.', ',')}`);
  } catch (err) { showToast('\u26A0\uFE0F ' + err.message); }
}

// Aus der Rennverwaltung: Datei waehlen und dem Rennen zuordnen.
// Das Rennen muss nicht aktiv sein.
let gpxTargetRaceId = null;

function pickGpxForRace(raceId) {
  gpxTargetRaceId = raceId;
  document.getElementById('gpxFileInput').click();
}

document.getElementById('gpxFileInput').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) { gpxTargetRaceId = null; return; }
  const target = gpxTargetRaceId;
  gpxTargetRaceId = null;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      if (!target) throw new Error('Kein Ziel-Rennen');
      const coords = parseGpx(e.target.result);
      await setRaceGpx(target, coords, file.name);
      // Nur zeichnen, wenn es das aktive Rennen betrifft
      if (target === activeRaceId) drawGpxLayer(coords);
      renderEventsBody();
    } catch (err) { alert('\u274C ' + err.message); }
    this.value = '';
  };
  reader.readAsText(file);
});

function parseGpx(xmlText) {
  const parser = new DOMParser();
  const xml    = parser.parseFromString(xmlText, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('Ung\u00FCltige GPX-Datei');
  const coords = [];
  xml.querySelectorAll('trkpt').forEach(pt => {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    if (!isNaN(lat) && !isNaN(lon)) coords.push([lat, lon]);
  });
  if (coords.length === 0) {
    xml.querySelectorAll('rtept').forEach(pt => {
      const lat = parseFloat(pt.getAttribute('lat'));
      const lon = parseFloat(pt.getAttribute('lon'));
      if (!isNaN(lat) && !isNaN(lon)) coords.push([lat, lon]);
    });
  }
  if (coords.length === 0) throw new Error('Keine Track-Punkte gefunden');
  return coords;
}

// Aus der Rennverwaltung: Strecke des Rennens entfernen.
async function removeGpxForRace(raceId) {
  await deleteRaceGpx(raceId);
  if (raceId === activeRaceId) clearGpxLayer();
}
