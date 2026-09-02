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

// Weisse Kontur unter jeder Linie, sobald mehr als eine Strecke auf
// der Karte liegt. Getrennt gefuehrt, damit sie beim Aufraeumen
// mitgeht - eine vergessene Kontur bliebe als weisser Strich stehen.
let gpxKontur      = Object.create(null);   // raceId -> L.polyline
// raceId -> Versatz in Bildschirmpixeln. Wird beim Zeichnen gesetzt
// und beim Zoomwechsel wieder gebraucht.
let gpxVersatz     = Object.create(null);

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
// verdeckt alle anderen. Ab 2.6.1 laufen sie deshalb wie Fahrspuren
// nebeneinander: jede Strecke wird senkrecht zur eigenen Fahrtrichtung
// um ein paar Bildschirmpixel versetzt (siehe versetzteCoords).
//
// Bis 2.6.0 war der Versatz eine feste Diagonale per CSS. Das hatte
// zwei Loecher: Strecken mit verschiedenem Startpunkt galten als nicht
// deckungsgleich und blieben uebereinander, und auf einer Strasse, die
// selbst diagonal verlief, schob die Verschiebung die Linie an sich
// selbst entlang statt zur Seite.
function zeichneStrecken() {
  for (const id of Object.keys(gpxLayerByRace)) {
    try { map.removeLayer(gpxLayerByRace[id]); } catch (e) { /* schon weg */ }
  }
  for (const id of Object.keys(gpxKontur)) {
    try { map.removeLayer(gpxKontur[id]); } catch (e) { /* schon weg */ }
  }
  gpxLayerByRace = Object.create(null);
  gpxKontur      = Object.create(null);
  gpxVersatz     = Object.create(null);
  gpxLayer = null;

  const ids = sichtbareRaceIds().filter(id => gpxByRace[id]);
  // Im Streckenmodus liegt nur die bearbeitete Strecke auf der Karte -
  // sonst koennte ein Tipp auf der falschen Linie landen und den
  // Zielstrich eines fremden Rennens verschieben.
  const zeichnen = (streckenModus && zielRaceId) ? ids.filter(id => id === zielRaceId) : ids;

  // HARTE REGEL: im Streckenmodus kein Versatz. Der Kartentipp meldet
  // die Koordinate unter dem Finger; laege die Linie daneben, wanderte
  // der Zielstrich um den Versatz mit - bei Zoom 14 sind fuenf Pixel
  // rund dreissig Meter, und daran haengt die Rundenzaehlung.
  gpxVersatz = (streckenModus && zielRaceId) ? Object.create(null) : versatzPlan(zeichnen);

  const mein = (typeof meinRaceId === 'function') ? meinRaceId() : null;
  // Das eigene Rennen zuletzt und eine Spur staerker: bei drei Linien
  // nebeneinander darf ausgerechnet die eigene nicht unten liegen.
  const folge = zeichnen.filter(id => id !== mein)
                        .concat(zeichnen.indexOf(mein) !== -1 ? [mein] : []);
  const staerke = id => (streckenModus && id === zielRaceId) ? 8 : (id === mein ? 5 : 4);

  const punkte = Object.create(null);
  folge.forEach(id => { punkte[id] = versetzteCoords(gpxByRace[id], gpxVersatz[id]); });

  // Erst alle Konturen, dann alle Farblinien. In einem Durchgang wuerde
  // die Kontur der Nachbarspur die zuvor gezeichnete Farblinie an der
  // Kante anknabbern. Liegt nur eine Strecke auf der Karte, entfaellt
  // die Kontur - das Bild ist dann genau das von 2.6.0.
  if (folge.length > 1) {
    folge.forEach(id => {
      gpxKontur[id] = L.polyline(punkte[id], {
        color: '#ffffff', weight: staerke(id) + 3, opacity: 0.9,
        lineJoin: 'round', lineCap: 'round', interactive: false
      }).addTo(map);
    });
  }

  folge.forEach(id => {
    const linie = L.polyline(punkte[id], {
      color: (streckenModus && id === zielRaceId) ? '#1565c0' : rennFarbe(id),
      weight: staerke(id),
      opacity: (streckenModus && id === zielRaceId) ? 0.95 : 0.85,
      lineJoin: 'round', lineCap: 'round'
    }).addTo(map);
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

// Abstand zweier Spuren in Bildschirmpixeln. Kleinster Wert, bei dem
// zwei Linien der Staerke 4 samt weisser Kontur noch getrennt lesbar
// sind - und klein genug, dass die Strecke im Uebersichtszoom nicht
// erkennbar neben der Strasse liegt.
const VERSATZ_PX = 5;

// Wer faehrt auf welcher Spur. Das eigene Rennen bekommt immer die
// Null und liegt damit exakt auf der Fahrbahn, so wie eine einzelne
// Strecke bis 2.6.0; die uebrigen wandern abwechselnd nach rechts und
// links. Die Stufe haengt an der Reihenfolge der Rennliste, nicht mehr
// am Startpunkt der Strecke - genau daran scheiterte 2.6.0, sobald
// zwei Rennen nur ein Teilstueck gemeinsam hatten.
function versatzPlan(ids) {
  const stufen = [0, 1, -1, 2];   // MAX_AKTIVE_RENNEN = 4
  const mein   = (typeof meinRaceId === 'function') ? meinRaceId() : null;
  const folge  = (ids.indexOf(mein) !== -1)
    ? [mein].concat(ids.filter(id => id !== mein))
    : ids.slice();
  const plan = Object.create(null);
  folge.forEach((id, i) => {
    plan[id] = (stufen[i] === undefined ? 0 : stufen[i]) * VERSATZ_PX;
  });
  return plan;
}

// Punkte einer Strecke um px Bildschirmpixel senkrecht zur
// Fahrtrichtung verschieben. Gerechnet wird im Pixelraum der Karte und
// danach zurueck nach Grad; deshalb muss das Ergebnis bei jedem
// Zoomwechsel neu gebildet werden (siehe aktualisiereVersatz).
//
// An einer Ecke zaehlt die Winkelhalbierende beider angrenzenden
// Segmente, verlaengert um 1/cos - sonst schnuerte die Linie in der
// Kurve ein. Bei einer Kehre liefe der Faktor gegen unendlich, deshalb
// ist er bei 0.55 gedeckelt: die Spitze wird dort leicht abgeflacht
// statt quer ueber die Karte zu schiessen.
//
// gpxByRace bleibt unberuehrt. Der Versatz existiert nur in den
// gezeichneten Punkten - Kilometrierung, Marker und Zielstrich rechnen
// weiter mit der echten Strecke.
function versetzteCoords(coords, px) {
  const c = coords || [];
  if (!px || c.length < 2) return c;
  const p = c.map(q => map.latLngToLayerPoint(L.latLng(q[0], q[1])));
  const n = p.length;
  const norm = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = p[i + 1].x - p[i].x, dy = p[i + 1].y - p[i].y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    norm.push([-dy / len, dx / len]);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = norm[i === 0 ? 0 : i - 1];
    const b = norm[i === n - 1 ? n - 2 : i];
    let nx = a[0] + b[0], ny = a[1] + b[1];
    const len = Math.sqrt(nx * nx + ny * ny) || 1;
    nx /= len; ny /= len;
    const cos = Math.max(0.55, a[0] * nx + a[1] * ny);
    const ll = map.layerPointToLatLng(
      L.point(p[i].x + nx * px / cos, p[i].y + ny * px / cos));
    out.push([ll.lat, ll.lng]);
  }
  return out;
}

// Beim Zoomen aendert sich das Verhaeltnis von Grad zu Pixel. Ohne
// Nachrechnen laegen die Spuren in der Uebersicht meterweit
// auseinander und im Nahzoom wieder deckungsgleich. Angefasst wird nur
// die Geometrie der Linien - Marker, Zielflaggen und Zonen bleiben
// stehen, deshalb kein volles zeichneStrecken().
function aktualisiereVersatz() {
  for (const id of Object.keys(gpxLayerByRace)) {
    const px = gpxVersatz[id] || 0;
    if (!px) continue;
    const neu = versetzteCoords(gpxByRace[id], px);
    try {
      gpxLayerByRace[id].setLatLngs(neu);
      if (gpxKontur[id]) gpxKontur[id].setLatLngs(neu);
    } catch (e) { /* Layer schon weg */ }
  }
}

map.on('zoomend', aktualisiereVersatz);

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
  for (const id of Object.keys(gpxKontur)) {
    try { map.removeLayer(gpxKontur[id]); } catch (e) { /* schon weg */ }
  }
  gpxLayerByRace = Object.create(null);
  gpxKontur = Object.create(null);
  gpxVersatz = Object.create(null);
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
