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
  drawRaceMarker();
}

function clearGpxLayer() {
  if (gpxLayer) { map.removeLayer(gpxLayer); gpxLayer = null; }
  gpxCoords = [];
  drawFinishMarker();
  clearRaceMarker();
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

// Streckenabschnitt zwischen zwei Metermarken als Punktliste.
// Laeuft ueber den Streckenanfang hinweg, wenn s2 kleiner ist als s1 -
// eine Verpflegungszone kann den Zielstrich einschliessen.
function gpxSlice(s1, s2) {
  if (gpxCoords.length < 2) return [];
  const cum = gpxCumulative();
  const L   = cum[cum.length - 1];
  if (!L) return [];
  const a = ((s1 % L) + L) % L;
  let laenge = (((s2 - s1) % L) + L) % L;
  if (laenge < 1) laenge = 1;          // entartete Zone bleibt sichtbar
  const zwischen = [];
  for (let i = 0; i < gpxCoords.length; i++) {
    const d = (((cum[i] - a) % L) + L) % L;
    if (d > 0 && d < laenge) zwischen.push({ d, p: gpxCoords[i] });
  }
  zwischen.sort((x, y) => x.d - y.d);
  return [gpxPointAt(a), ...zwischen.map(z => z.p), gpxPointAt(a + laenge)]
    .filter(Boolean);
}

// =======================
// ZIELMARKER UND STRECKENMODUS
// =======================
let finishMarker = null;
let streckenModus = false;

// Rennen, dessen Start/Ziel gerade gesetzt wird. Frueher war das
// implizit immer das aktive Rennen. Seit die Bedienung in der
// Rennverwaltung sitzt, kann es auch ein vorbereitetes sein - dann
// aber nur ueber die km-Eingabe, weil auf der Karte die Linie des
// aktiven Rennens liegt.
let zielRaceId = null;

// Marker, der gerade per Kartentipp gesetzt wird. null heisst: der
// Tipp gilt dem Zielstrich, wie bisher.
let zielMarkerId = null;

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

// =======================
// STRECKENMARKER
// =======================
// Sprint, Bergwertung, Verpflegungszone und freie Punkte. Sie liegen
// als Meter am Rennen (raceMeta.marker) und kommen ueber /active mit.
// Start/Ziel ist bewusst NICHT dabei - das ist startOffset und haengt
// am Rundenzaehler.
const MARKER_ART = {
  start:       { icon: '\u{1F6A9}', label: 'Start',        farbe: '#2e7d32', zone: false },
  wertung:     { icon: '\u{1F3C5}', label: 'Sprint',       farbe: '#1565c0', zone: false },
  berg:        { icon: '\u26F0\uFE0F', label: 'Bergwertung', farbe: '#6d4c41', zone: false },
  verpflegung: { icon: '\u{1F34C}', label: 'Verpflegung',  farbe: '#ef6c00', zone: true  },
  frei:        { icon: '\u{1F4CC}', label: 'Punkt',        farbe: '#6a1b9a', zone: true  }
};

function markerArt(typ) { return MARKER_ART[typ] || MARKER_ART.frei; }

// "km 3,40" - dieselbe Schreibweise wie im Streckeneditor.
function kmText(meter) {
  return 'km ' + ((meter || 0) / 1000).toFixed(2).replace('.', ',');
}

function markerBeschriftung(m) {
  const a = markerArt(m.typ);
  let t = `${a.icon} ${m.name ? m.name : a.label} \u00B7 ${kmText(m.s)}`;
  if (m.sEnde !== undefined && m.sEnde !== null) t += ` \u2013 ${kmText(m.sEnde)}`;
  if (Array.isArray(m.runden) && m.runden.length) t += ` \u00B7 Runde ${m.runden.join(', ')}`;
  return t;
}

let markerLayer = [];

function clearRaceMarker() {
  markerLayer.forEach(l => { try { map.removeLayer(l); } catch (e) { /* schon weg */ } });
  markerLayer = [];
}

function markerIcon(typ) {
  const a = markerArt(typ);
  return L.divIcon({
    className: '', iconSize: [24, 24], iconAnchor: [12, 12],
    html: `<div class="lt-mk" style="border-color:${a.farbe}">${a.icon}</div>`
  });
}

// Zeichnet alle Marker des aktiven Rennens. Zonen zuerst, damit die
// Symbole darueber liegen und anklickbar bleiben.
function drawRaceMarker() {
  clearRaceMarker();
  if (!activeInfo || !activeInfo.raceId || gpxCoords.length < 2) return;
  const liste = Array.isArray(activeInfo.marker) ? activeInfo.marker : [];

  liste.forEach(m => {
    if (!m || typeof m.s !== 'number') return;
    const a = markerArt(m.typ);
    const txt = markerBeschriftung(m);

    if (a.zone && m.sEnde !== undefined && m.sEnde !== null) {
      const pts = gpxSlice(m.s, m.sEnde);
      if (pts.length > 1) {
        markerLayer.push(L.polyline(pts, {
          color: a.farbe, weight: 11, opacity: 0.45, lineCap: 'butt', interactive: false
        }).addTo(map));
      }
    }
    const p = gpxPointAt(m.s);
    if (!p) return;
    markerLayer.push(L.marker(p, { icon: markerIcon(m.typ), interactive: false })
      .addTo(map)
      .bindTooltip(txt, { direction: 'top' }));
  });
}

// Wird nach dem Speichern aus der Rennverwaltung gerufen: betrifft die
// Aenderung das gerade angezeigte Rennen, wandert sie sofort auf die
// Karte, statt bis zum naechsten /active-Takt zu warten.
function uebernehmeMarker(raceId, liste) {
  if (!activeInfo || activeInfo.raceId !== raceId) return;
  activeInfo.marker = Array.isArray(liste) ? liste : [];
  drawRaceMarker();
}

function setStreckenModus(an, raceId, markerId) {
  streckenModus = !!an && authLevel === 'spolei';
  zielRaceId = streckenModus
    ? (raceId || (activeInfo && activeInfo.raceId) || null)
    : null;
  zielMarkerId = streckenModus ? (markerId || null) : null;
  document.getElementById('streckenBar').classList.toggle('hidden', !streckenModus);
  beschrifteStreckenBar();
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
  if (!el) return;
  el.value = (zielOffset() / 1000).toFixed(2).replace('.', ',');
}

// Die Leiste sagt immer, WAS der naechste Tipp setzt. Ohne das waere
// nicht zu unterscheiden, ob gerade der Zielstrich oder eine Wertung
// verschoben wird - und ein versehentlich verschobener Zielstrich
// verwirft mitten im Rennen die Rundenzaehlung.
function beschrifteStreckenBar() {
  const bar = document.getElementById('streckenBar');
  if (!bar) return;
  const titel = bar.querySelector('.sbTitel');
  const hint  = bar.querySelector('.sbHint');
  const km    = document.getElementById('streckenKm');
  const ok    = document.getElementById('streckenKmOk');
  const mk    = zielMarkerId ? findeMarker(zielRaceId, zielMarkerId) : null;

  if (mk) {
    const a = markerArt(mk.typ);
    if (titel) titel.textContent = `${a.icon} ${mk.name || a.label} setzen`;
    if (hint)  hint.textContent  = 'auf die Strecke tippen';
    // Das km-Feld gehoert zum Zielstrich. In der Markerlage waere nicht
    // zu erkennen, worauf es wirkt - also weg damit.
    if (km) km.classList.add('hidden');
    if (ok) ok.classList.add('hidden');
    bar.classList.add('mkModus');
  } else {
    if (titel) titel.textContent = '\u{1F4D0} Start/Ziel setzen';
    if (hint)  hint.textContent  = 'auf die Strecke tippen \u2013 oder km eingeben:';
    if (km) km.classList.remove('hidden');
    if (ok) ok.classList.remove('hidden');
    bar.classList.remove('mkModus');
  }
}

function findeMarker(raceId, mid) {
  if (typeof findRace !== 'function') return null;
  const r = findRace(raceId);
  const l = (r && Array.isArray(r.marker)) ? r.marker : [];
  return l.find(x => x && x.id === mid) || null;
}

// Aktueller Versatz des Zielrennens. Bevorzugt die Rennliste, weil dort
// auch nicht aktive Rennen stehen; activeInfo ist der Rueckfall, solange
// die Liste noch nicht geladen ist (Zuschauer ohne Login).
function zielOffset() {
  if (zielRaceId && typeof findRace === 'function') {
    const r = findRace(zielRaceId);
    if (r) return r.startOffset || 0;
  }
  return (activeInfo && activeInfo.startOffset) || 0;
}

// Tipp auf die Strecke: der Server projiziert die Koordinate mit
// derselben Rechnung wie eine GPS-Meldung.
async function onTrackClick(e) {
  // Auf der Karte liegt die Strecke des AKTIVEN Rennens. Ein Tipp darf
  // deshalb nie auf ein anderes Rennen gehen, auch wenn zielRaceId aus
  // irgendeinem Grund noch auf einem alten Wert steht.
  if (!streckenModus || !activeInfo || !activeInfo.raceId) return;
  if (zielRaceId && zielRaceId !== activeInfo.raceId) return;
  L.DomEvent.stop(e);
  // Bewusst zwei getrennte Funktionen statt eines Schalters in
  // sendeZiel(): so gibt es keinen Weg, auf dem ein Markertipp am
  // Zielstrich landet.
  if (zielMarkerId) {
    await sendeMarkerPunkt({ atLat: e.latlng.lat, atLon: e.latlng.lng });
  } else {
    await sendeZiel({ atLat: e.latlng.lat, atLon: e.latlng.lng }, activeInfo.raceId);
  }
}

// Verschiebt den gerade bearbeiteten Marker. Fehler landen im Toast:
// im fahrenden Auto ist ein Dialog nicht zu bedienen.
async function sendeMarkerPunkt(felder) {
  const rid = zielRaceId;
  const mid = zielMarkerId;
  const mk  = findeMarker(rid, mid);
  if (!rid || !mid || !mk) { showToast('\u26A0\uFE0F Kein Punkt ausgew\u00E4hlt'); return null; }
  try {
    const d = await saveMarker(rid, { id: mid, typ: mk.typ, ...felder });
    uebernehmeMarker(rid, d.marker);
    const neu = (d.marker || []).find(x => x && x.id === mid);
    beschrifteStreckenBar();
    showToast(`${markerArt(mk.typ).icon} ${mk.name || markerArt(mk.typ).label} bei ${
      kmText(neu ? neu.s : 0)}`);
    return d;
  } catch (err) { showToast('\u26A0\uFE0F ' + err.message); return null; }
}

// Setzt Start/Ziel eines Rennens. raceId ist optional: ohne Angabe gilt
// das Rennen des Streckenmodus, sonst das aktive. Fehler landen im Toast
// und nicht als Ausnahme beim Aufrufer - der Kartentipp hat keinen
// Platz fuer einen Dialog.
async function sendeZiel(felder, raceId) {
  const ziel = raceId || zielRaceId || (activeInfo && activeInfo.raceId);
  if (!ziel) { showToast('\u26A0\uFE0F Kein Rennen gew\u00E4hlt'); return null; }
  try {
    const d = await setRaceLaps(ziel, felder);
    // Marker und Karte nur anfassen, wenn es wirklich das Rennen ist,
    // das gerade auf der Karte liegt.
    if (activeInfo && ziel === activeInfo.raceId) {
      activeInfo.startOffset = d.startOffset;
      drawFinishMarker();
    }
    if (streckenModus) zeigeZielKm();
    showToast(`\u{1F3C1} Start/Ziel bei km ${(d.startOffset / 1000).toFixed(2).replace('.', ',')}`);
    return d;
  } catch (err) { showToast('\u26A0\uFE0F ' + err.message); return null; }
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
