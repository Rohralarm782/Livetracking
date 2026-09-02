// =======================
// GPX TRACKS
// =======================
// Die Strecke gehoert zum Rennen und wird in der Rennverwaltung
// hochgeladen. /gpx liefert immer die Strecke des AKTIVEN Rennens,
// deshalb muss die Linie beim Rennenwechsel neu geholt werden.
// Bis 1.19.0 lag genau eine Strecke auf der Karte. Ab 2.0 koennen bis
// zu vier Rennen gleichzeitig laufen, also haelt die Karte eine Strecke
// je Rennen.
//
// gpxCoords bleibt daneben bestehen und zeigt auf die Strecke des
// FOKUSRENNENS - jenes Rennens, das der Streckenmodus bearbeitet oder
// das der Nutzer als seines markiert hat. Daran haengen der
// Streckeneditor und die Kilometrierung, die beide von Natur aus genau
// ein Rennen meinen.
let gpxLayerByRace = Object.create(null);   // raceId -> L.polyline
let gpxByRace      = Object.create(null);   // raceId -> coords[]
let gpxLayer       = null;                  // Linie des Fokusrennens
let gpxCoords      = [];                    // Punkte des Fokusrennens

// Duenne durchgezogene Grundlinie unter der gestrichelten Farblinie,
// sobald mehr als eine Strecke auf der Karte liegt. Ohne sie saehe ein
// Abschnitt, auf dem nur ein Rennen faehrt, zerrissen aus. Getrennt
// gefuehrt, damit sie beim Aufraeumen mitgeht - eine vergessene
// Grundlinie bliebe als blasser Strich stehen.
let gpxGrundlinie  = Object.create(null);   // raceId -> L.polyline

// Welches Rennen der Nutzer sehen will, steht in map.js
// (sichtbareRennen). gpx.js fragt nur nach - so gibt es genau eine
// Wahrheit ueber die Auswahl.
function sichtbareRaceIds() {
  return (typeof sichtbareRennenListe === 'function') ? sichtbareRennenListe() : [];
}

function rennFarbe(raceId) {
  if (typeof steckbriefOf === 'function') {
    const s = steckbriefOf(raceId);
    if (s && s.farbe) return s.farbe;
  }
  return '#e65100';
}

// Holt die Strecken aller sichtbaren Rennen. Bis 1.19.0 lieferte /gpx
// immer die Strecke des Leitrennens; der race-Parameter ist ab 2.0
// dabei.
async function fetchGpxTrack() {
  const ids = sichtbareRaceIds();
  try {
    const neu = Object.create(null);
    for (const id of ids) {
      const res  = await fetch(`${SERVER}/gpx?race=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (data && data.coords && data.coords.length > 0) neu[id] = data.coords;
    }
    gpxByRace = neu;
    zeichneStrecken();
  } catch (err) { console.error('GPX fetch:', err); }
}

// Alle sichtbaren Strecken zeichnen. Fahren mehrere Rennen dieselbe
// Strasse - der Normalfall bei U15w und U15m einer Veranstaltung -,
// liegen die Linien exakt uebereinander und die zuletzt gezeichnete
// verdeckt alle anderen. Ab 2.6.2 tragen sie deshalb dasselbe
// Strichmuster mit verschobener Phase: auf einem gemeinsamen Abschnitt
// wechseln sich die Rennfarben ab, jede kommt garantiert dran.
//
// Zwei Anlaeufe davor, beide verworfen:
//   2.6.0  fester diagonaler Versatz per CSS. Griff nur bei gleichem
//          Startpunkt, und auf einer diagonalen Strasse schob er die
//          Linie an sich selbst entlang statt zur Seite.
//   2.6.1  echter Parallelversatz senkrecht zur Fahrtrichtung. Sauber
//          auf glatten Strecken, aber auf einer Aufzeichnung liegen
//          die Punkte wenige Meter auseinander und tragen Rauschen:
//          die Richtung schwankte um 13 bis 35 Grad, jeder Punkt wurde
//          anders verschoben, die Linie franste aus.
//
// Das Strichmuster verschiebt gar nichts. Die Geometrie bleibt exakt
// auf der Strasse - fuer den Kartentipp im Streckenmodus, fuer die
// Kilometrierung und fuer die Lage von Zielflagge und Zonen ist das
// der entscheidende Unterschied.
function zeichneStrecken() {
  for (const id of Object.keys(gpxLayerByRace)) {
    try { map.removeLayer(gpxLayerByRace[id]); } catch (e) { /* schon weg */ }
  }
  for (const id of Object.keys(gpxGrundlinie)) {
    try { map.removeLayer(gpxGrundlinie[id]); } catch (e) { /* schon weg */ }
  }
  gpxLayerByRace = Object.create(null);
  gpxGrundlinie  = Object.create(null);
  gpxLayer = null;

  const ids = sichtbareRaceIds().filter(id => gpxByRace[id]);
  // Im Streckenmodus liegt nur die bearbeitete Strecke auf der Karte -
  // sonst koennte ein Tipp auf der falschen Linie landen und den
  // Zielstrich eines fremden Rennens verschieben.
  const zeichnen = (streckenModus && zielRaceId) ? ids.filter(id => id === zielRaceId) : ids;

  const mein = (typeof meinRaceId === 'function') ? meinRaceId() : null;
  // Das eigene Rennen zuletzt und eine Spur staerker: liegen drei
  // Linien uebereinander, darf ausgerechnet die eigene nicht unten
  // liegen.
  const folge = zeichnen.filter(id => id !== mein)
                        .concat(zeichnen.indexOf(mein) !== -1 ? [mein] : []);
  const staerke = id => (streckenModus && id === zielRaceId) ? 8 : (id === mein ? 7 : 6);

  // Eine einzelne Strecke bleibt durchgezogen, im Streckenmodus
  // ebenfalls. Gestrichelt wird nur, wenn es etwas zu unterscheiden
  // gibt.
  const muster = (folge.length > 1 && !streckenModus)
    ? strichPlan(zeichnen) : Object.create(null);
  const gestrichelt = Object.keys(muster).length > 0;

  // Erst alle Grundlinien, dann alle Farblinien. In einem Durchgang
  // wuerde die Grundlinie des naechsten Rennens die Striche des
  // vorigen ueberdecken.
  if (gestrichelt) {
    folge.forEach(id => {
      gpxGrundlinie[id] = L.polyline(gpxByRace[id], {
        color: rennFarbe(id), weight: 2, opacity: 0.45,
        lineJoin: 'round', lineCap: 'round', interactive: false
      }).addTo(map);
    });
  }

  folge.forEach(id => {
    const opt = {
      color: (streckenModus && id === zielRaceId) ? '#1565c0' : rennFarbe(id),
      weight: staerke(id),
      opacity: (streckenModus && id === zielRaceId) ? 0.95 : 0.85,
      lineJoin: 'round', lineCap: 'round'
    };
    if (gestrichelt) {
      // Butt statt Round: runde Enden lassen benachbarte Striche
      // ineinanderlaufen, die Farbfolge wird dann unsauber.
      opt.lineCap     = 'butt';
      opt.dashArray   = STRICH_PX + ' ' + (folge.length - 1) * STRICH_PX;
      opt.dashOffset  = String(muster[id]);
    }
    const linie = L.polyline(gpxByRace[id], opt).addTo(map);
    linie.on('click', onTrackClick);
    gpxLayerByRace[id] = linie;
  });

  // Fokusrennen: im Streckenmodus das bearbeitete, sonst das eigene
  // Rennen, sonst das erste sichtbare.
  const fokus = (streckenModus && zielRaceId) ? zielRaceId : fokusRaceId();
  gpxCoords = (fokus && gpxByRace[fokus]) ? gpxByRace[fokus] : [];
  gpxLayer  = gpxLayerByRace[fokus] || null;

  drawFinishMarker();
  drawRaceMarker();
}

// Laenge eines Strichs in Bildschirmpixeln. Gross genug, dass die
// Farbe in der Uebersicht als Farbe und nicht als Punktreihe
// erscheint; klein genug, dass auf einem kurzen gemeinsamen Stueck
// jedes Rennen wenigstens einmal vorkommt. Bei drei Rennen wiederholt
// sich die Folge alle 54 Pixel.
//
// Das Muster ist ein Bildschirmmass und macht deshalb jeden Zoom
// unveraendert mit - anders als ein Versatz in Koordinaten braucht es
// keine Neuberechnung.
const STRICH_PX = 18;

// Wer zeichnet in welcher Phase. Das eigene Rennen faengt bei Null an,
// die uebrigen folgen in der Reihenfolge der Rennliste. Zwei Rennen
// duerfen nie dieselbe Phase bekommen, sonst liegen ihre Striche
// wieder uebereinander.
function strichPlan(ids) {
  const mein  = (typeof meinRaceId === 'function') ? meinRaceId() : null;
  const folge = (ids.indexOf(mein) !== -1)
    ? [mein].concat(ids.filter(id => id !== mein))
    : ids.slice();
  // Positiv, nicht negativ: negative Werte fuer stroke-dashoffset sind
  // erst ab SVG 2 zulaessig. Die Richtung der Verschiebung ist egal,
  // solange sich die Phasen unterscheiden.
  const plan = Object.create(null);
  folge.forEach((id, i) => { plan[id] = i * STRICH_PX; });
  return plan;
}

// Welches Rennen ist gemeint, wenn nur eines gemeint sein kann.
function fokusRaceId() {
  if (typeof meinRaceId === 'function') {
    const m = meinRaceId();
    if (m && gpxByRace[m]) return m;
  }
  const ids = sichtbareRaceIds().filter(id => gpxByRace[id]);
  return ids[0] || null;
}

function clearGpxLayer() {
  for (const id of Object.keys(gpxLayerByRace)) {
    try { map.removeLayer(gpxLayerByRace[id]); } catch (e) { /* schon weg */ }
  }
  for (const id of Object.keys(gpxGrundlinie)) {
    try { map.removeLayer(gpxGrundlinie[id]); } catch (e) { /* schon weg */ }
  }
  gpxLayerByRace = Object.create(null);
  gpxGrundlinie = Object.create(null);
  gpxByRace = Object.create(null);
  gpxLayer  = null;
  gpxCoords = [];
  drawFinishMarker();
  clearRaceMarker();
}

// Bis 1.19.0 nahm drawGpxLayer die Punkte direkt entgegen. Der Aufruf
// steht noch im GPX-Import der Rennverwaltung.
function drawGpxLayer(coords, raceId) {
  const id = raceId || fokusRaceId() || (typeof activeRaceId !== 'undefined' ? activeRaceId : null);
  if (id) gpxByRace[id] = coords;
  zeichneStrecken();
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
// Ohne Angabe gilt die Strecke des Fokusrennens - so bleiben die
// bestehenden Aufrufe gueltig.
function gpxCumulative(coords) {
  const c = coords || gpxCoords;
  const cum = [0];
  for (let i = 1; i < c.length; i++) {
    cum[i] = cum[i - 1] + distMeters(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
  }
  return cum;
}

// Punkte einer bestimmten Strecke, mit Rueckfall auf das Fokusrennen.
function coordsOf(raceId) {
  if (raceId && gpxByRace[raceId]) return gpxByRace[raceId];
  return gpxCoords;
}

// Position auf der Runde (Meter) -> [lat, lon]
function gpxPointAt(meter, raceId) {
  const c = coordsOf(raceId);
  if (c.length < 2) return null;
  const cum = gpxCumulative(c);
  const L   = cum[cum.length - 1];
  if (!L) return null;
  const s = ((meter % L) + L) % L;
  let i = 1;
  while (i < cum.length && cum[i] < s) i++;
  const f = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
  return [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * f,
          c[i - 1][1] + (c[i][1] - c[i - 1][1]) * f];
}

// Fahrtrichtung an einer Streckenposition, in Grad. Wird zum
// Zusammenlegen von Punkten gebraucht: auf einem Kurs mit Wendepunkt
// liegen Hin- und Rueckweg oft nur zehn Meter auseinander, sind aber
// verschiedene Streckenabschnitte. Ohne Richtungsvergleich wuerde eine
// Wertung bei km 4 mit einer bei km 12 verschmelzen.
function gpxBearingAt(meter, raceId) {
  const a = gpxPointAt(meter - 12, raceId);
  const b = gpxPointAt(meter + 12, raceId);
  if (!a || !b) return null;
  const rad = Math.PI / 180;
  const dLon = (b[1] - a[1]) * rad;
  const y = Math.sin(dLon) * Math.cos(b[0] * rad);
  const x = Math.cos(a[0] * rad) * Math.sin(b[0] * rad)
          - Math.sin(a[0] * rad) * Math.cos(b[0] * rad) * Math.cos(dLon);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

// Streckenabschnitt zwischen zwei Metermarken als Punktliste.
// Laeuft ueber den Streckenanfang hinweg, wenn s2 kleiner ist als s1 -
// eine Verpflegungszone kann den Zielstrich einschliessen.
function gpxSlice(s1, s2, raceId) {
  const c = coordsOf(raceId);
  if (c.length < 2) return [];
  const cum = gpxCumulative(c);
  const L   = cum[cum.length - 1];
  if (!L) return [];
  const a = ((s1 % L) + L) % L;
  let laenge = (((s2 - s1) % L) + L) % L;
  if (laenge < 1) laenge = 1;          // entartete Zone bleibt sichtbar
  const zwischen = [];
  for (let i = 0; i < c.length; i++) {
    const d = (((cum[i] - a) % L) + L) % L;
    if (d > 0 && d < laenge) zwischen.push({ d, p: c[i] });
  }
  zwischen.sort((x, y) => x.d - y.d);
  return [gpxPointAt(a, raceId), ...zwischen.map(z => z.p), gpxPointAt(a + laenge, raceId)]
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
// Ein Zielstrich je sichtbarem Rennen. finishMarker bleibt als Zeiger
// auf den des Fokusrennens bestehen.
let finishByRace = Object.create(null);

function clearFinishMarker() {
  for (const id of Object.keys(finishByRace)) {
    try { map.removeLayer(finishByRace[id]); } catch (e) { /* schon weg */ }
  }
  finishByRace = Object.create(null);
  if (finishMarker) { try { map.removeLayer(finishMarker); } catch (e) {} finishMarker = null; }
}

function drawFinishMarker() {
  clearFinishMarker();
  const ids = sichtbareRaceIds().filter(id => (gpxByRace[id] || []).length > 1);
  // Zuschauer direkt nach dem Seitenaufruf: die Steckbriefliste ist
  // noch nicht da, die Strecke des Leitrennens aber schon.
  if (!ids.length) return drawFinishMarkerAlt();
  const zeichnen = (streckenModus && zielRaceId) ? ids.filter(id => id === zielRaceId) : ids;
  zeichnen.forEach(id => {
    const s = (typeof steckbriefOf === 'function') ? steckbriefOf(id) : null;
    const p = gpxPointAt((s && s.startOffset) || 0, id);
    if (!p) return;
    const mk = L.marker(p, { icon: finishIcon, interactive: false }).addTo(map);
    finishByRace[id] = mk;
    if (id === fokusRaceId()) finishMarker = mk;
  });
}

// Alter Pfad: zeichnet den Zielmarker des Leitrennens aus activeInfo.
// Bleibt fuer den Fall stehen, dass die Steckbriefliste noch nicht
// geladen ist - etwa bei einem Zuschauer direkt nach dem Seitenaufruf.
function drawFinishMarkerAlt() {
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
  frei:        { icon: '\u{1F4CC}', label: 'Punkt',        farbe: '#6a1b9a', zone: true  },
  zwischenzeit:{ icon: '\u23F1\uFE0F', label: 'ZZ',         farbe: '#00838f', zone: false }
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

// Ein Punkt, der fuer mehrere Rennen gilt: ein Symbol, aussen ein Ring
// aus einem Segment je Rennen. Bei genau einem Rennen ergibt das einen
// einfachen Farbring - die Darstellung bleibt damit fast so, wie sie
// bis 1.19.0 war.
function markerIconRing(typ, farben) {
  const a = markerArt(typ);
  if (!farben || farben.length < 2) {
    return L.divIcon({
      className: '', iconSize: [24, 24], iconAnchor: [12, 12],
      html: `<div class="lt-mk" style="border-color:${farben && farben[0] ? farben[0] : a.farbe}">${a.icon}</div>`
    });
  }
  const R = 15, C = 16, dick = 4;
  const u = 2 * Math.PI * R;
  const seg = farben.map((f, i) => {
    const teil = u / farben.length;
    return `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${f}"
      stroke-width="${dick}" stroke-dasharray="${teil - 1.5} ${u - teil + 1.5}"
      stroke-dashoffset="${-i * teil}" transform="rotate(-90 ${C} ${C})"/>`;
  }).join('');
  return L.divIcon({
    className: '', iconSize: [32, 32], iconAnchor: [16, 16],
    html: `<div class="lt-mkr"><svg width="32" height="32" viewBox="0 0 32 32">${seg}</svg>`
        + `<span class="lt-mkr-i">${a.icon}</span></div>`
  });
}

// Punkte verschiedener Rennen, die an derselben Stelle liegen, werden
// zu einem Symbol zusammengefasst. Drei Bedingungen muessen alle
// zutreffen:
//   - gleicher Typ (eine Verpflegung verschmilzt nicht mit einem Sprint)
//   - hoechstens MK_CLUSTER_M Luftlinie
//   - Fahrtrichtung weicht um weniger als 60 Grad ab
// Die Richtungspruefung ist der Grund, warum 100 m tragbar sind: auf
// einem Kurs mit Wendepunkt liegt die Gegenrichtung oft nur zehn Meter
// entfernt, gehoert aber zu einem ganz anderen Streckenabschnitt.
const MK_CLUSTER_M    = 100;
const MK_CLUSTER_GRAD = 60;

function winkelDiff(a, b) {
  if (a === null || b === null) return 0;
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function sammleMarker() {
  const gruppen = [];
  sichtbareRaceIds().forEach(rid => {
    if ((gpxByRace[rid] || []).length < 2) return;
    const s = (typeof steckbriefOf === 'function') ? steckbriefOf(rid) : null;
    const liste = (s && Array.isArray(s.marker)) ? s.marker : [];
    liste.forEach(m => {
      if (!m || typeof m.s !== 'number') return;
      const p = gpxPointAt(m.s, rid);
      if (!p) return;
      const kurs = gpxBearingAt(m.s, rid);
      const treffer = gruppen.find(g =>
        g.typ === m.typ
        && distMeters(g.lat, g.lon, p[0], p[1]) <= MK_CLUSTER_M
        && winkelDiff(g.kurs, kurs) < MK_CLUSTER_GRAD);
      if (treffer) treffer.eintraege.push({ raceId: rid, m });
      else gruppen.push({ typ: m.typ, lat: p[0], lon: p[1], kurs,
                          eintraege: [{ raceId: rid, m }] });
    });
  });
  return gruppen;
}

function clusterText(g) {
  const a = markerArt(g.typ);
  const kopf = `${a.icon} ${g.eintraege[0].m.name || a.label}`;
  const zeilen = g.eintraege.map(e => {
    const nm = (typeof raceLabel === 'function') ? raceLabel(e.raceId, true) : e.raceId;
    let z = `<span class="lt-tt-d" style="background:${rennFarbe(e.raceId)}"></span>${nm}`
          + ` \u00B7 ${kmText(e.m.s)}`;
    if (e.m.sEnde !== undefined && e.m.sEnde !== null) z += ` \u2013 ${kmText(e.m.sEnde)}`;
    if (Array.isArray(e.m.runden) && e.m.runden.length) z += ` \u00B7 Runde ${e.m.runden.join(', ')}`;
    return `<div class="lt-tt-r">${z}</div>`;
  }).join('');
  return `<div class="lt-tt-h">${kopf}</div>${zeilen}`;
}

// Zeichnet die Marker aller sichtbaren Rennen. Zonen zuerst, damit die
// Symbole darueber liegen und anklickbar bleiben.
function drawRaceMarker() {
  clearRaceMarker();
  const gruppen = sammleMarker();

  // Zonen: jede fuer sich, in der Farbe ihres Rennens. Sie liegen
  // flaechig auf der Strecke, ein Zusammenlegen wuerde die Grenzen
  // verwischen.
  gruppen.forEach(g => {
    const a = markerArt(g.typ);
    if (!a.zone) return;
    g.eintraege.forEach(e => {
      if (e.m.sEnde === undefined || e.m.sEnde === null) return;
      const pts = gpxSlice(e.m.s, e.m.sEnde, e.raceId);
      if (pts.length > 1) {
        markerLayer.push(L.polyline(pts, {
          color: rennFarbe(e.raceId), weight: 11, opacity: 0.40,
          lineCap: 'butt', interactive: false
        }).addTo(map));
      }
    });
  });

  gruppen.forEach(g => {
    const farben = g.eintraege.map(e => rennFarbe(e.raceId));
    markerLayer.push(
      L.marker([g.lat, g.lon], { icon: markerIconRing(g.typ, farben), interactive: false })
        .addTo(map)
        .bindTooltip(clusterText(g), { direction: 'top', className: 'lt-tt' }));
  });
}

// Wird nach dem Speichern aus der Rennverwaltung gerufen: betrifft die
// Aenderung das gerade angezeigte Rennen, wandert sie sofort auf die
// Karte, statt bis zum naechsten /active-Takt zu warten.
function uebernehmeMarker(raceId, liste) {
  // Bis 1.19.0 lag nur das Leitrennen auf der Karte. Ab 2.0 kann die
  // Aenderung jedes sichtbare Rennen betreffen.
  if (typeof setzeSteckbriefMarker === 'function') {
    setzeSteckbriefMarker(raceId, Array.isArray(liste) ? liste : []);
  }
  if (activeInfo && activeInfo.raceId === raceId) {
    activeInfo.marker = Array.isArray(liste) ? liste : [];
  }
  if (sichtbareRaceIds().indexOf(raceId) === -1) return;
  drawRaceMarker();
}

// Der Streckenmodus wird aus dem Renn-Panel gestartet und kann damit
// auch ein Rennen betreffen, das noch nicht laeuft - dessen Strecke
// liegt dann nicht im Cache, weil fetchGpxTrack() nur die sichtbaren
// Rennen holt.
async function ladeStreckeFuer(raceId) {
  if (!raceId || gpxByRace[raceId]) return;
  try {
    const res  = await fetch(`${SERVER}/gpx?race=${encodeURIComponent(raceId)}`);
    const data = await res.json();
    if (data && data.coords && data.coords.length > 0) gpxByRace[raceId] = data.coords;
  } catch (err) { console.error('GPX fetch:', err); }
}

function setStreckenModus(an, raceId, markerId) {
  streckenModus = !!an && authLevel === 'spolei';
  zielRaceId = streckenModus
    ? (raceId || fokusRaceId() || (activeInfo && activeInfo.raceId) || null)
    : null;
  if (streckenModus && zielRaceId && !gpxByRace[zielRaceId]) {
    // Nachladen und danach neu zeichnen - der Modus laeuft schon, die
    // Linie kommt einen Wimpernschlag spaeter.
    ladeStreckeFuer(zielRaceId).then(() => { if (streckenModus) zeichneStrecken(); });
  }
  zielMarkerId = streckenModus ? (markerId || null) : null;
  document.getElementById('streckenBar').classList.toggle('hidden', !streckenModus);
  beschrifteStreckenBar();
  // Solange der Modus laeuft, liegt nur die bearbeitete Strecke auf der
  // Karte. Das uebernimmt zeichneStrecken(), das den Modus mit
  // auswertet - eine Umfaerbung der einen Linie reicht ab 2.0 nicht
  // mehr, weil sonst drei fremde Linien danebenliegen und ein Fehltipp
  // den Zielstrich des falschen Rennens verschiebt.
  zeichneStrecken();
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
  // Der Streckenmodus wird ab 2.0 aus dem Renn-Panel heraus gestartet
  // und traegt die Renn-ID mit sich. Ohne zielRaceId passiert nichts:
  // ein Tipp ohne eindeutiges Rennen koennte den Zielstrich eines
  // laufenden Rennens verschieben und dessen Rundenzaehlung verwerfen.
  if (!streckenModus || !zielRaceId) return;
  L.DomEvent.stop(e);
  // Bewusst zwei getrennte Funktionen statt eines Schalters in
  // sendeZiel(): so gibt es keinen Weg, auf dem ein Markertipp am
  // Zielstrich landet.
  if (zielMarkerId) {
    await sendeMarkerPunkt({ atLat: e.latlng.lat, atLon: e.latlng.lng });
  } else {
    await sendeZiel({ atLat: e.latlng.lat, atLon: e.latlng.lng }, zielRaceId);
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
    // Der Versatz gehoert dem Rennen, nicht der Karte. Ab 2.0 wird er
    // im Steckbrief dieses Rennens nachgefuehrt; liegt es auf der
    // Karte, wandert der Zielstrich sofort mit.
    if (typeof setzeSteckbriefOffset === 'function') {
      setzeSteckbriefOffset(ziel, d.startOffset);
    }
    if (activeInfo && ziel === activeInfo.raceId) activeInfo.startOffset = d.startOffset;
    if (sichtbareRaceIds().indexOf(ziel) !== -1) drawFinishMarker();
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
      // Nur zeichnen, wenn die Strecke gerade sichtbar ist
      if (sichtbareRaceIds().indexOf(target) !== -1) drawGpxLayer(coords, target);
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
  if (gpxByRace[raceId]) { delete gpxByRace[raceId]; zeichneStrecken(); }
}
