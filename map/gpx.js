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

// Weisse Kontur unter jeder Spur, sobald mehr als eine Strecke auf der
// Karte liegt. Sie trennt benachbarte Spuren auf hellem Kartengrund.
// Getrennt gefuehrt, damit sie beim Aufraeumen mitgeht - eine
// vergessene Kontur bliebe als weisser Strich stehen.
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
// verdeckt alle anderen. Ab 2.6.3 laufen sie wie Fahrspuren
// nebeneinander: jede Strecke wird senkrecht zu ihrer geglaetteten
// Fahrtrichtung um wenige Bildschirmpixel versetzt.
//
// Drei Anlaeufe davor:
//   2.6.0  fester diagonaler Versatz per CSS. Griff nur bei gleichem
//          Startpunkt, und auf einer diagonalen Strasse schob er die
//          Linie an sich selbst entlang statt zur Seite.
//   2.6.1  Parallelversatz, Richtung aus dem Nachbarpunkt. Auf einer
//          Aufzeichnung liegen die Punkte wenige Meter auseinander und
//          tragen Rauschen; die Richtung schwankte um 13 bis 35 Grad
//          und die Linie franste aus.
//   2.6.2  Strichmuster mit verschobener Phase. Die Phase zaehlt ab
//          dem eigenen Streckenanfang, die Strecken sind aber
//          verschieden lang: auf gemeinsamen Abschnitten trafen
//          Striche auf Striche statt auf Luecken, und eine Farbe fiel
//          aus. Verschiedene Strichlaengen halfen nicht, weil bei
//          jeder Ueberlappung die zuletzt gezeichnete Linie gewinnt.
//
// 2.6.3 ist 2.6.1 mit geglaetteter Richtung (siehe versetzteCoords).
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
  // Das eigene Rennen zuletzt und eine Spur staerker: bei drei Spuren
  // nebeneinander darf ausgerechnet die eigene nicht unten liegen.
  const folge = zeichnen.filter(id => id !== mein)
                        .concat(zeichnen.indexOf(mein) !== -1 ? [mein] : []);
  const staerke = id => (streckenModus && id === zielRaceId) ? 8 : (id === mein ? 5 : 4);

  const punkte = Object.create(null);
  const cum    = Object.create(null);
  folge.forEach(id => {
    punkte[id] = versetzteCoords(gpxByRace[id], gpxVersatz[id]);
    cum[id]    = gpxCumulative(gpxByRace[id]);
  });

  // Aussparungen. Bis 2.8.0 hoerten die Linien unter jedem Marker auf:
  //     ----------(S)----------
  // Das Symbol war ein Emoji in einer weissen Scheibe und der
  // zusammengelegte Ring 32 Pixel breit - beides deckte die Linien
  // schlecht, also machten die Linien Platz. Seit 2.8.0 ist das Symbol
  // eine deckende Scheibe von 24 Pixeln und liegt in der Markerebene
  // ueber den Linien. Die Spuren laufen deshalb wieder durch; die
  // Luecke war ab da nur noch ein sichtbarer Bruch im Streckenverlauf.
  //
  // Geblieben ist die Zonenluecke: dort tritt das dicke Zonenband an
  // die Stelle der Linie (siehe drawRaceMarker). Sie gilt nur fuer das
  // Rennen, dem die Zone gehoert.
  //
  // Im Streckenmodus wird nichts ausgespart. Dort wird auf die Linie
  // getippt, und eine Luecke waere eine Stelle, an der ein Tipp ins
  // Leere geht.
  const gruppen = (streckenModus && zielRaceId) ? [] : sammleMarker();
  const zonen   = zonenPlan(folge, gruppen);

  // Erst alle Konturen, dann alle Farblinien. In einem Durchgang wuerde
  // die Kontur der Nachbarspur die zuvor gezeichnete Farblinie an der
  // Kante anknabbern. Liegt nur eine Strecke auf der Karte, entfaellt
  // die Kontur - das Bild ist dann das einer einzelnen Strecke wie vor
  // 2.6.0.
  //
  // Die Kontur kennt die Zonenluecken nicht: so bekommt die Zone
  // denselben weissen Rand wie die Linie, an deren Stelle sie tritt.
  // Seit 2.8.1 hat sie damit ueberhaupt keine Luecken mehr und laeuft
  // durch.
  if (folge.length > 1) {
    folge.forEach(id => {
      gpxKontur[id] = L.polyline(punkte[id], {
        color: '#ffffff', weight: staerke(id) + 3, opacity: 0.9,
        lineJoin: 'round', lineCap: 'round', interactive: false
      }).addTo(map);
    });
  }

  folge.forEach(id => {
    const linie = L.polyline(
      mitLuecken(punkte[id], cum[id], zonen[id]), {
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

// Abstand zweier Spuren in Bildschirmpixeln.
const VERSATZ_PX = 5;

// Ueber welche Strecke die Fahrtrichtung gemittelt wird, ebenfalls in
// Bildschirmpixeln. Das ist der Unterschied zu 2.6.1: dort kam die
// Richtung aus dem direkten Nachbarpunkt, und der liegt auf einer
// Aufzeichnung nur wenige Meter entfernt - bei 26 m Punktabstand und
// 3 m Rauschen schwankt die Richtung dann um rund 13 Grad, bei
// dichteren Punkten um bis zu 35. Ueber 25 Pixel gemittelt faellt das
// Rauschen heraus, die Linie bleibt glatt, und echte Kurven sind auf
// dieser Laenge noch gut aufgeloest.
const GLAETTUNG_PX = 25;

// Wer faehrt auf welcher Spur. Das eigene Rennen bekommt immer die
// Null und liegt damit exakt auf der Fahrbahn; die uebrigen wandern
// abwechselnd nach rechts und links. Die Stufe haengt an der
// Reihenfolge der Rennliste, nicht am Startpunkt der Strecke - daran
// scheiterte 2.6.0, sobald zwei Rennen nur ein Teilstueck gemeinsam
// hatten.
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
// Die Richtung an einem Punkt ist die Verbindung zwischen dem letzten
// Punkt mindestens GLAETTUNG_PX davor und dem ersten mindestens
// GLAETTUNG_PX danach. Beide Grenzen werden mit mitlaufenden Zeigern
// gesucht, nicht je Punkt neu - sonst waere der Aufwand im
// Uebersichtszoom, wo hunderte Punkte in dasselbe Fenster fallen,
// quadratisch.
//
// gpxByRace bleibt unberuehrt. Der Versatz existiert nur in den
// gezeichneten Punkten - Kilometrierung, Marker und Zielstrich rechnen
// weiter mit der echten Strecke.
function versetzteCoords(coords, px) {
  const c = coords || [];
  if (!px || c.length < 2) return c;
  const p = c.map(q => map.latLngToLayerPoint(L.latLng(q[0], q[1])));
  const n = p.length;
  const weit = (a, b) => {
    const dx = p[a].x - p[b].x, dy = p[a].y - p[b].y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // vor[i]  = erster Punkt ab i, der weit genug voraus liegt
  const vor = new Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (j < i) j = i;
    while (j + 1 < n && weit(i, j) < GLAETTUNG_PX) j++;
    vor[i] = j;
  }
  // zur[i] = letzter Punkt bis i, der weit genug zurueck liegt
  const zur = new Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    while (k + 1 <= i && weit(i, k + 1) >= GLAETTUNG_PX) k++;
    zur[i] = k;
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    let a = zur[i], b = vor[i];
    let dx = p[b].x - p[a].x, dy = p[b].y - p[a].y;
    // Eine Runde endet dort, wo sie begonnen hat: dann koennen beide
    // Grenzen auf denselben Punkt fallen. In dem Fall der direkte
    // Nachbar - lieber eine leicht unruhige Stelle als geteilt durch
    // null.
    if (dx === 0 && dy === 0) {
      a = Math.max(0, i - 1); b = Math.min(n - 1, i + 1);
      dx = p[b].x - p[a].x; dy = p[b].y - p[a].y;
    }
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ll = map.layerPointToLatLng(
      L.point(p[i].x - dy / len * px, p[i].y + dx / len * px));
    out.push([ll.lat, ll.lng]);
  }
  return out;
}

// Beim Zoomen aendert sich das Verhaeltnis von Grad zu Pixel. Ohne
// Nachrechnen laegen die Spuren in der Uebersicht meterweit
// auseinander und im Nahzoom wieder deckungsgleich.
//
// Bis 2.6.3 wurde dafuer nur die Geometrie der beiden Linien
// nachgezogen. Jetzt haengen auch die Zonen am Zoom, und die zeichnet
// drawRaceMarker(). Ein voller Neuaufbau ist deshalb der ehrlichere
// Weg - er kostet dasselbe wie ein Takt der Streckenabfrage, der
// ohnehin laufend passiert.
map.on('zoomend', zeichneStrecken);

// Streckenposition einer Koordinate, plus deren Abstand zur Strecke.
//
// Projiziert auf die Segmente, nicht auf die Stuetzpunkte. Der
// Unterschied ist nicht akademisch: eine Aufzeichnung hat Punkte alle
// 25 m, eine von Hand gezeichnete Route kann auf einer geraden
// Landstrasse zwei Kilometer am Stueck ohne Zwischenpunkt haben - der
// naechste Stuetzpunkt laege dann hunderte Meter entfernt und die
// Liste der naechsten Punkte zeigte still auf die falsche Stelle.
//
// Gerechnet wird in einer ebenen Naeherung um den gesuchten Punkt.
// Ueber die paar hundert Meter, um die es hier geht, ist der Fehler
// weit unter einem Meter, und es faellt keine Winkelfunktion je
// Streckenpunkt an.
function sNaechst(lat, lon, coords, cum) {
  const n = coords.length;
  if (n < 2 || !cum || cum.length < n) return null;
  const rad = Math.PI / 180, R = 6371000;
  const kx = R * rad * Math.cos(lat * rad), ky = R * rad;
  const px = lon * kx, py = lat * ky;
  let best = Infinity, bs = 0;
  for (let i = 1; i < n; i++) {
    const ax = coords[i - 1][1] * kx, ay = coords[i - 1][0] * ky;
    const vx = coords[i][1] * kx - ax, vy = coords[i][0] * ky - ay;
    const l2 = vx * vx + vy * vy;
    let t = l2 ? ((px - ax) * vx + (py - ay) * vy) / l2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const dx = px - (ax + vx * t), dy = py - (ay + vy * t);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < best) { best = d; bs = cum[i - 1] + (cum[i] - cum[i - 1]) * t; }
  }
  return { s: bs, dist: best };
}

// Je Rennen eine Liste von Sperrbereichen in Metern: die Abschnitte
// seiner Verpflegungs- und Punktzonen. Dort tritt das Zonenband an die
// Stelle der Linie, also muss die Linie weichen.
//
// Bis 2.8.0 stand hier zusaetzlich ein Ringteil, der unter jedem
// Markersymbol jede vorbeikommende Spur aussparte. Er ist mit 2.8.1
// entfallen - siehe den Kommentar in zeichneStrecken(). Mit ihm faellt
// eine Projektion je Markergruppe und Rennen ueber alle Streckenpunkte
// weg, die bei jedem Zoomwechsel neu lief.
function zonenPlan(ids, gruppen) {
  const plan = Object.create(null);
  ids.forEach(id => { plan[id] = []; });
  if (!gruppen || !gruppen.length) return plan;

  gruppen.forEach(g => {
    if (!markerArt(g.typ).zone) return;
    g.eintraege.forEach(e => {
      if (e.m.sEnde === undefined || e.m.sEnde === null) return;
      // Ohne Band bleibt die Linie stehen: es gibt nichts, was an ihre
      // Stelle traete.
      if (e.m.band === false) return;
      if (!plan[e.raceId]) return;
      plan[e.raceId].push([e.m.s, e.m.sEnde]);
    });
  });
  return plan;
}

// Punkt an einer Metermarke, interpoliert. Sucht binaer - bei 4000
// Punkten und zwei Aufrufen je Teilstueck summiert sich lineares
// Suchen sonst spuerbar.
function punktBei(punkte, cum, m) {
  const n = punkte.length;
  if (m <= cum[0]) return punkte[0];
  if (m >= cum[n - 1]) return punkte[n - 1];
  let lo = 1, hi = n - 1;
  while (lo < hi) {
    const mi = (lo + hi) >> 1;
    if (cum[mi] < m) lo = mi + 1; else hi = mi;
  }
  const f = (m - cum[lo - 1]) / ((cum[lo] - cum[lo - 1]) || 1);
  return [punkte[lo - 1][0] + (punkte[lo][0] - punkte[lo - 1][0]) * f,
          punkte[lo - 1][1] + (punkte[lo][1] - punkte[lo - 1][1]) * f];
}

// Punktliste in Teilstuecke zerlegen, die die Sperrbereiche aussparen.
// Rueckgabe ist eine Liste von Listen - L.polyline zeichnet daraus
// mehrere Striche in EINEM Layer. Der Klick-Handler haengt damit
// weiterhin an genau einem Objekt je Rennen.
//
// Die Metermarken beziehen sich auf die echte Strecke, die Punkte
// koennen versetzt sein; beide haben denselben Index, deshalb passt
// dieselbe Aufteilung.
function mitLuecken(punkte, cum, luecken) {
  const n = punkte.length;
  const laenge = n > 1 ? cum[n - 1] : 0;
  if (!laenge || !luecken || !luecken.length) return punkte;

  // Auf [0, laenge) normieren. Eine Zone darf ueber den Streckenanfang
  // laufen und zerfaellt dann in zwei Sperrbereiche.
  const sperr = [];
  luecken.forEach(l => {
    const von = ((l[0] % laenge) + laenge) % laenge;
    const bis = ((l[1] % laenge) + laenge) % laenge;
    if (bis <= von) { sperr.push([von, laenge]); sperr.push([0, bis]); }
    else            { sperr.push([von, bis]); }
  });
  sperr.sort((a, b) => a[0] - b[0]);

  const frei = [];
  let pos = 0;
  sperr.forEach(b => {
    if (b[0] > pos) frei.push([pos, b[0]]);
    if (b[1] > pos) pos = b[1];
  });
  if (pos < laenge) frei.push([pos, laenge]);

  const teile = [];
  frei.forEach(f => {
    if (f[1] - f[0] < 1) return;
    const t = [punktBei(punkte, cum, f[0])];
    for (let i = 0; i < n; i++) if (cum[i] > f[0] && cum[i] < f[1]) t.push(punkte[i]);
    t.push(punktBei(punkte, cum, f[1]));
    if (t.length > 1) teile.push(t);
  });
  return teile;
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
// Streckenschilder fuer Sprint, Bergwertung und Verpflegung. Eigene
// Zeichnung statt Emoji: Emoji rendern auf jedem Geraet anders und sind
// aus dem fahrenden Auto schlecht zu erkennen. Die drei Zeichen folgen
// der Beschilderung am Streckenrand - gruenes S, rotes Bergschild,
// blaues Besteck. Das Markup ist fest verdrahtet, es kommt kein
// Benutzertext hinein. Zwischenzeit und freier Punkt behalten ihr
// Emoji: sie sind keine Wertung, sondern eine eigene Notiz.
const MK_SYM_KOPF = '<svg class="lt-sym" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">';
const MK_SYM_SPRINT = MK_SYM_KOPF
  + '<circle cx="12" cy="12" r="10.6" fill="#2e9b4f" stroke="#fff" stroke-width="2"/>'
  + '<text x="12" y="17" text-anchor="middle" font-family="Arial, Helvetica, sans-serif"'
  + ' font-size="14" font-weight="700" fill="#fff">S</text></svg>';
const MK_SYM_BERG = MK_SYM_KOPF
  + '<circle cx="12" cy="12" r="10.6" fill="#d62828" stroke="#fff" stroke-width="2"/>'
  + '<path d="M5 16.8 L9.9 8.4 L12.9 12.4 L15 9.6 L19 16.8 Z" fill="#fff"/></svg>';
const MK_GLYPH_FOOD =
    '<path d="M8.2 6.2v3.2M10 6.2v3.2M11.8 6.2v3.2" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/>'
  + '<path d="M7.9 9.1h4.2v.9a2.1 2.1 0 0 1-4.2 0Z" fill="#fff"/>'
  + '<path d="M10 11.8v6" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>'
  + '<path d="M15.4 6.1c2.1 1.1 2.1 4.9 0 5.9Z" fill="#fff"/>'
  + '<path d="M15.4 11.6v6.2" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>';
const MK_SYM_FOOD = MK_SYM_KOPF
  + '<circle cx="12" cy="12" r="10.6" fill="#1976d2" stroke="#fff" stroke-width="2"/>'
  + MK_GLYPH_FOOD + '</svg>';

// Zonenende. Dasselbe Schild, gedaempft und durchgestrichen - der
// Strich liegt zweimal uebereinander, weiss als Kontur und rot darauf,
// damit er auch auf dunklem Kartengrund steht.
const MK_SYM_FOOD_ENDE = MK_SYM_KOPF
  + '<circle cx="12" cy="12" r="10.6" fill="#5b7fa6" stroke="#fff" stroke-width="2"/>'
  + '<g opacity=".75">' + MK_GLYPH_FOOD + '</g>'
  + '<path d="M4.6 19.4 L19.4 4.6" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>'
  + '<path d="M4.6 19.4 L19.4 4.6" stroke="#c62828" stroke-width="2" stroke-linecap="round"/></svg>';

const MARKER_ART = {
  start:       { icon: '\u{1F6A9}', label: 'Start',        farbe: '#2e7d32', zone: false },
  wertung:     { icon: '\u{1F3C5}', svg: MK_SYM_SPRINT, label: 'Sprint',       farbe: '#1565c0', zone: false },
  berg:        { icon: '\u26F0\uFE0F', svg: MK_SYM_BERG, label: 'Bergwertung', farbe: '#6d4c41', zone: false },
  verpflegung: { icon: '\u{1F34C}', svg: MK_SYM_FOOD, svgEnde: MK_SYM_FOOD_ENDE,
                 label: 'Verpflegung',  farbe: '#ef6c00', zoneFarbe: '#1976d2', zone: true  },
  frei:        { icon: '\u{1F4CC}', label: 'Punkt',        farbe: '#6a1b9a', zoneFarbe: '#6a1b9a', zone: true  },
  zwischenzeit:{ icon: '\u23F1\uFE0F', label: 'ZZ',         farbe: '#00838f', zone: false }
};

function markerArt(typ) { return MARKER_ART[typ] || MARKER_ART.frei; }

// Das Zeichen fuer eine Flaeche: Schild, wo es eines gibt, sonst das
// Emoji. Nur fuer Stellen, an denen HTML erlaubt ist - in Tooltips,
// Toasts und Ueberschriften bleibt a.icon stehen, dort landet der Wert
// als Text.
function markerSymbol(typ) {
  const a = markerArt(typ);
  return a.svg || a.icon;
}

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

// =======================
// NAECHSTE PUNKTE AB EINER POSITION (ab 2.7.0)
// =======================
// Bezugspunkt ist die Position, die der SpoLei sendet (TEAMAUTO). Sie
// markiert, wo das Rennen gerade ist, und liegt ueber /positions jedem
// Geraet vor - auch ohne Login und ohne eigene Ortung. Wer selbst
// ortet, rechnet mit der eigenen Koordinate (siehe map.js).
//
// Gerechnet wird ausschliesslich hier im Browser, gegen die Strecke des
// EIGENEN Rennens. Der Serverwert p.s taugt dafuer nicht: den rechnet
// verfolgeStrecke() gegen das Leitrennen, nicht gegen das Rennen, das
// dieses Geraet ausgewaehlt hat.
//
// Nichts hier schreibt: startOffset, marker[] und die Streckenpunkte
// werden nur gelesen.

const NP_ANZAHL     = 5;     // so viele Zeilen
const NP_ABSEITS_M  = 250;   // darueber gilt die Projektion als unsicher
const NP_RUNDKURS_M = 200;   // Abstand Anfang/Ende, bis zu dem es eine Runde ist
const NP_ZIEL_ICON  = '\u{1F3C1}';

// gpxCumulative() laeuft ueber alle Streckenpunkte. Bis 2.6.7 fiel das
// nicht auf, weil die Summe nur beim Zeichnen gebraucht wurde - jetzt
// im Sekundentakt. Map haelt die Einfuegereihenfolge, der aelteste
// Eintrag fliegt zuerst.
const npCum = new Map();     // coords-Array -> cum[]

function npCumOf(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const treffer = npCum.get(coords);
  if (treffer) return treffer;
  const c = gpxCumulative(coords);
  npCum.set(coords, c);
  // Vier Rennen, dazu ein Streckenwechsel: mehr als acht Eintraege
  // sind immer Altlast.
  if (npCum.size > 8) npCum.delete(npCum.keys().next().value);
  return c;
}

// Rundkurs oder Punkt-zu-Punkt. Auf einem Rundkurs liegt hinter dem
// Zielstrich die naechste Runde; auf einer Strecke von A nach B liegt
// dort nichts mehr, und die Modulo-Rechnung wuerde einen laengst
// passierten Sprint als "in 47 km" ausgeben.
function npIstRundkurs(coords) {
  const n = coords.length;
  if (n < 2) return false;
  return distMeters(coords[0][0], coords[0][1],
                    coords[n - 1][0], coords[n - 1][1]) <= NP_RUNDKURS_M;
}

// Die naechsten Punkte ab einer Koordinate, in Fahrtrichtung sortiert.
// Rueckgabe: null, wenn es nichts zu zeigen gibt, sonst
//   { abstand, abseits, eintraege: [{ icon, d, ende, spaeter }] }
function naechstePunkteAb(lat, lon, raceId) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !raceId) return null;
  const coords = gpxByRace[raceId];
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const cum = npCumOf(coords);
  if (!cum) return null;
  const L = cum[cum.length - 1];
  if (!L) return null;
  const t = sNaechst(lat, lon, coords, cum);
  if (!t) return null;

  const sb        = (typeof steckbriefOf === 'function') ? steckbriefOf(raceId) : null;
  const off       = sb ? (sb.startOffset || 0) : 0;
  const runde     = (sb && sb.currentLap) ? sb.currentLap : 1;
  const zielrunde = !!(sb && sb.finalLap);
  const rund      = npIstRundkurs(coords);

  // Beide Werte stehen in Metern ab GPX-Anfang - der startOffset muss
  // dafuer nicht herausgerechnet werden, er kuerzt sich weg.
  const vor   = x => (((x - t.s) % L) + L) % L;
  const dZiel = vor(off);

  const roh = [];
  // Der Zielstrich steht nicht in marker[], sondern ist der
  // startOffset des Rennens.
  roh.push({ icon: NP_ZIEL_ICON, d: dZiel, ende: false, runden: null });

  const liste = (sb && Array.isArray(sb.marker)) ? sb.marker : [];
  liste.forEach(m => {
    if (!m || typeof m.s !== 'number') return;
    if (m.typ === 'start') return;              // sagt im Rennen nichts
    const a    = markerArt(m.typ);
    const zone = !!a.zone && m.sEnde !== undefined && m.sEnde !== null;
    // Stehen wir schon in der Zone, ist ihr Anfang Vergangenheit -
    // dann bleibt nur ihr Ende uebrig.
    const drin = zone
      && ((((t.s - m.s) % L) + L) % L) <= ((((m.sEnde - m.s) % L) + L) % L);
    const sym  = a.svg || a.icon;
    if (!drin) roh.push({ icon: sym, d: vor(m.s),     ende: false, runden: m.runden });
    if (zone)  roh.push({ icon: sym, d: vor(m.sEnde), ende: true,  runden: m.runden });
  });

  const eintraege = [];
  roh.forEach(e => {
    // Alles hinter dem Zielstrich gehoert zur naechsten Runde.
    const spaeter = e.d > dZiel;
    if (spaeter && (!rund || zielrunde)) return;
    const r = spaeter ? runde + 1 : runde;
    if (Array.isArray(e.runden) && e.runden.length && e.runden.indexOf(r) === -1) return;
    eintraege.push({ icon: e.icon, d: e.d, ende: !!e.ende, spaeter });
  });
  if (!eintraege.length) return null;
  eintraege.sort((a, b) => a.d - b.d);
  return {
    abstand:   t.dist,
    abseits:   t.dist > NP_ABSEITS_M,
    eintraege: eintraege.slice(0, NP_ANZAHL)
  };
}

let markerLayer = [];

function clearRaceMarker() {
  markerLayer.forEach(l => { try { map.removeLayer(l); } catch (e) { /* schon weg */ } });
  markerLayer = [];
}

// Bis 2.7.0 trug ein Punkt, der fuer mehrere Rennen gilt, aussen einen
// Ring aus einem Segment je Rennen (markerIconRing). Der ist mit 2.8.0
// entfallen: die Wertungen liegen fast immer fuer alle Rennen an
// derselben Stelle, nur bei verschiedenen Kilometern - und genau die
// stehen weiterhin zeilenweise im Tooltip (clusterText). Der Ring hat
// dafuer 8 px Durchmesser und den Kontrast des Schildes gekostet.
function markerIcon(typ) {
  const a = markerArt(typ);
  return L.divIcon({
    className: '', iconSize: [24, 24], iconAnchor: [12, 12],
    html: a.svg || `<div class="lt-mk" style="border-color:${a.farbe}">${a.icon}</div>`
  });
}

// Das Schild am Ende einer Zone. Wo es ein gezeichnetes Schild gibt,
// steht dafuer eine eigene Fassung bereit; sonst bekommt die weisse
// Scheibe den Strich aus dem Stilblatt (.lt-mk-ende).
function markerIconEnde(typ) {
  const a = markerArt(typ);
  return L.divIcon({
    className: '', iconSize: [24, 24], iconAnchor: [12, 12],
    html: a.svgEnde
       || `<div class="lt-mk lt-mk-ende" style="border-color:${a.farbe}">${a.icon}</div>`
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

// Dieselbe Sammlung fuer die ENDEN der Zonen, in einer eigenen Liste.
// Zusammen mit den Anfaengen wuerde eine sehr kurze Zone sonst beide
// Schilder in dieselbe Gruppe legen und eines davon verschlucken.
//
// Das Ende wird auch dann gezeichnet, wenn das Band abgeschaltet ist -
// gerade dann ist es das einzige, was den Abschnitt begrenzt.
function sammleZonenEnden() {
  const gruppen = [];
  sichtbareRaceIds().forEach(rid => {
    if ((gpxByRace[rid] || []).length < 2) return;
    const s = (typeof steckbriefOf === 'function') ? steckbriefOf(rid) : null;
    const liste = (s && Array.isArray(s.marker)) ? s.marker : [];
    liste.forEach(m => {
      if (!m || !markerArt(m.typ).zone) return;
      if (m.sEnde === undefined || m.sEnde === null) return;
      const p = gpxPointAt(m.sEnde, rid);
      if (!p) return;
      const kurs = gpxBearingAt(m.sEnde, rid);
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

// ende = true beschriftet die Gruppe als Zonenende und zeigt je Rennen
// den Kilometer des Endes statt der Spanne.
function clusterText(g, ende) {
  const a = markerArt(g.typ);
  const name = g.eintraege[0].m.name || a.label;
  const kopf = ende ? `${a.icon} Ende ${name}` : `${a.icon} ${name}`;
  const zeilen = g.eintraege.map(e => {
    const nm = (typeof raceLabel === 'function') ? raceLabel(e.raceId, true) : e.raceId;
    let z = `<span class="lt-tt-d" style="background:${rennFarbe(e.raceId)}"></span>${nm}`;
    if (ende) {
      z += ` \u00B7 ${kmText(e.m.sEnde)}`;
    } else {
      z += ` \u00B7 ${kmText(e.m.s)}`;
      if (e.m.sEnde !== undefined && e.m.sEnde !== null) z += ` \u2013 ${kmText(e.m.sEnde)}`;
    }
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

  // Zonen: jede fuer sich. Ein Zusammenlegen wuerde die Grenzen
  // verwischen.
  //
  // Bis 2.6.3 lag die Zone als blasses breites Band auf der Fahrbahn.
  // Seit die Spuren versetzt sind, verschwand sie darunter - das Band
  // aus drei Spuren und Konturen ist breiter als die Zone selbst. Jetzt
  // laeuft die Zone auf der Spur ihres Rennens und tritt dort an die
  // Stelle der Linie, die zeichneStrecken() genau fuer diesen Abschnitt
  // ausspart.
  //
  // Seit 2.9.0 in der Farbe des Schildes statt der des Rennens: in der
  // Rennfarbe war die Zone nur dieselbe Linie, drei Pixel dicker, und
  // damit praktisch nicht zu erkennen. Welchem Rennen sie gehoert,
  // sagt weiterhin die Spurlage - das Band liegt auf dem Versatz seines
  // Rennens.
  gruppen.forEach(g => {
    const a = markerArt(g.typ);
    if (!a.zone) return;
    g.eintraege.forEach(e => {
      if (e.m.sEnde === undefined || e.m.sEnde === null) return;
      // Ohne Band bleiben nur die beiden Schilder stehen. Gedacht fuer
      // lange Abschnitte - etwa die Strecke, auf der aus dem Fahrzeug
      // verpflegt werden darf: ein Band ueber 40 km wuerde die Karte
      // beherrschen, ohne mehr zu sagen als Anfang und Ende.
      if (e.m.band === false) return;
      const pts = gpxSlice(e.m.s, e.m.sEnde, e.raceId);
      if (pts.length > 1) {
        // So stark wie die weisse Kontur breit ist: die Zone fuellt die
        // Spur samt Rand aus. Dadurch schwillt die Spur sichtbar an und
        // verliert auf dem Abschnitt ihren weissen Saum - ein Signal,
        // das auch in der Uebersicht traegt, ohne in die Nachbarspur zu
        // ragen.
        const eigen = (typeof meinRaceId === 'function') && meinRaceId() === e.raceId;
        markerLayer.push(L.polyline(versetzteCoords(pts, gpxVersatz[e.raceId] || 0), {
          color: a.zoneFarbe || rennFarbe(e.raceId), weight: eigen ? 8 : 7, opacity: 0.9,
          lineCap: 'butt', interactive: false
        }).addTo(map));
      }
    });
  });

  gruppen.forEach(g => {
    markerLayer.push(
      L.marker([g.lat, g.lon], { icon: markerIcon(g.typ), interactive: false })
        .addTo(map)
        .bindTooltip(clusterText(g), { direction: 'top', className: 'lt-tt' }));
  });

  sammleZonenEnden().forEach(g => {
    markerLayer.push(
      L.marker([g.lat, g.lon], { icon: markerIconEnde(g.typ), interactive: false })
        .addTo(map)
        .bindTooltip(clusterText(g, true), { direction: 'top', className: 'lt-tt' }));
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
  // Nicht nur drawRaceMarker(): seit 2.6.4 haengen die Aussparungen in
  // den Linien an den Markern, und die zeichnet zeichneStrecken().
  // Sie ruft drawRaceMarker() am Ende selbst auf.
  zeichneStrecken();
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
