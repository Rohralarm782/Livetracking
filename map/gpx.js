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

  // Aussparungen. Ein zusammengefasster Markerring misst 32 Pixel, das
  // Spurband bei drei Rennen rund 16 - der Ring deckt die Linien also
  // ohnehin. Statt ihn zu ueberzeichnen, hoeren die Linien dort auf:
  //     ----------(S)----------
  // Die Ringluecke gilt fuer JEDE Spur, die dort vorbeikommt, auch fuer
  // ein Rennen ohne eigenen Marker an der Stelle - sonst laeuft dessen
  // Linie weiter durch das Symbol. Die Zonenluecke gilt nur fuer das
  // Rennen, dem die Zone gehoert: dort tritt die Zone an die Stelle der
  // Linie (siehe drawRaceMarker).
  //
  // Im Streckenmodus wird nichts ausgespart. Dort wird auf die Linie
  // getippt, und eine Luecke waere eine Stelle, an der ein Tipp ins
  // Leere geht.
  const gruppen = (streckenModus && zielRaceId) ? [] : sammleMarker();
  const luecken = lueckenPlan(folge, cum, gruppen);

  // Erst alle Konturen, dann alle Farblinien. In einem Durchgang wuerde
  // die Kontur der Nachbarspur die zuvor gezeichnete Farblinie an der
  // Kante anknabbern. Liegt nur eine Strecke auf der Karte, entfaellt
  // die Kontur - das Bild ist dann das einer einzelnen Strecke wie vor
  // 2.6.0.
  //
  // Die Kontur kennt nur die Ringluecken, nicht die Zonenluecken: so
  // bekommt die Zone denselben weissen Rand wie die Linie, an deren
  // Stelle sie tritt.
  if (folge.length > 1) {
    folge.forEach(id => {
      gpxKontur[id] = L.polyline(mitLuecken(punkte[id], cum[id], luecken.ring[id]), {
        color: '#ffffff', weight: staerke(id) + 3, opacity: 0.9,
        lineJoin: 'round', lineCap: 'round', interactive: false
      }).addTo(map);
    });
  }

  folge.forEach(id => {
    const linie = L.polyline(
      mitLuecken(punkte[id], cum[id], luecken.ring[id].concat(luecken.zone[id])), {
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
// auseinander und im Nahzoom wieder deckungsgleich. Dasselbe gilt seit
// 2.6.4 fuer die Aussparungen, deren Breite in Pixeln festgelegt ist.
//
// Bis 2.6.3 wurde dafuer nur die Geometrie der beiden Linien
// nachgezogen. Jetzt haengen auch die Zonen am Zoom, und die zeichnet
// drawRaceMarker(). Ein voller Neuaufbau ist deshalb der ehrlichere
// Weg - er kostet dasselbe wie ein Takt der Streckenabfrage, der
// ohnehin laufend passiert.
map.on('zoomend', zeichneStrecken);

// Breite der Aussparung unter einem Marker, in Bildschirmpixeln. Der
// zusammengefasste Ring misst 32 Pixel, das einzelne Symbol 24. Die
// Luecke ist bewusst deutlich breiter als das Symbol: sie soll den
// Marker frei stellen, nicht nur knapp umschliessen - sonst kleben die
// Linien an seinem Rand und das Symbol geht im Band unter.
const LUECKE_RING_PX  = 56;
const LUECKE_PUNKT_PX = 46;

// Deckel, damit im weit herausgezoomten Bild nicht ein halber Rundkurs
// verschwindet: hoechstens zwei Prozent der Streckenlaenge, bei einem
// 100-km-Rennen also zwei Kilometer. In den Zoomstufen, in denen im
// Auto gearbeitet wird, greift der Deckel nie - dort sind 56 Pixel
// einige hundert Meter. Der Mindestwert haelt die Luecke auch bei
// einem kurzen Rundkurs brauchbar.
const LUECKE_MAX_ANTEIL = 0.02;
const LUECKE_MIN_M      = 250;

// Wie nah ein Rennen an einem Marker vorbeikommen muss, damit seine
// Spur ausgespart wird. Faehrt es weiter weg, deckt der Ring seine
// Linie gar nicht.
const LUECKE_NAH_M = 60;

// Wie viele Meter ein Bildschirmpixel im aktuellen Zoom entspricht.
function meterProPixel() {
  const breite = 40075016.686 * Math.cos(map.getCenter().lat * Math.PI / 180);
  return breite / (256 * Math.pow(2, map.getZoom()));
}

// Streckenposition einer Koordinate, plus deren Abstand zur Strecke.
//
// Projiziert auf die Segmente, nicht auf die Stuetzpunkte. Der
// Unterschied ist nicht akademisch: eine Aufzeichnung hat Punkte alle
// 25 m, eine von Hand gezeichnete Route kann auf einer geraden
// Landstrasse zwei Kilometer am Stueck ohne Zwischenpunkt haben - der
// naechste Stuetzpunkt laege dann hunderte Meter entfernt und die
// Aussparung fiele still aus.
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

// Je Rennen zwei Listen von Sperrbereichen in Metern:
//   ring - unter jedem Markersymbol, fuer jede Spur, die dort
//          vorbeikommt
//   zone - der Abschnitt einer Verpflegungs- oder Punktzone, nur fuer
//          das Rennen, dem sie gehoert
function lueckenPlan(ids, cum, gruppen) {
  const plan = { ring: Object.create(null), zone: Object.create(null) };
  ids.forEach(id => { plan.ring[id] = []; plan.zone[id] = []; });
  if (!gruppen || !gruppen.length) return plan;

  const mpp = meterProPixel();
  gruppen.forEach(g => {
    const gross = g.eintraege.length > 1;
    const roh = (gross ? LUECKE_RING_PX : LUECKE_PUNKT_PX) / 2 * mpp;
    ids.forEach(id => {
      const t = sNaechst(g.lat, g.lon, gpxByRace[id] || [], cum[id] || []);
      if (!t || t.dist > LUECKE_NAH_M) return;
      // Der Deckel haengt an der Laenge DIESER Strecke: zwei Rennen mit
      // sehr verschiedener Distanz sollen im selben Bild nicht
      // unterschiedlich stark ausgespart werden, solange beide weit
      // genug sind.
      const c   = cum[id];
      const max = Math.max(LUECKE_MIN_M, (c[c.length - 1] || 0) * LUECKE_MAX_ANTEIL);
      const halb = Math.min(roh, max / 2);
      plan.ring[id].push([t.s - halb, t.s + halb]);
    });
    // Zonen stehen in denselben Gruppen - so wird die Markerliste nur
    // einmal durchlaufen.
    if (!markerArt(g.typ).zone) return;
    g.eintraege.forEach(e => {
      if (e.m.sEnde === undefined || e.m.sEnde === null) return;
      if (!plan.zone[e.raceId]) return;
      plan.zone[e.raceId].push([e.m.s, e.m.sEnde]);
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
    if (!drin) roh.push({ icon: a.icon, d: vor(m.s),     ende: false, runden: m.runden });
    if (zone)  roh.push({ icon: a.icon, d: vor(m.sEnde), ende: true,  runden: m.runden });
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

  // Zonen: jede fuer sich, in der Farbe ihres Rennens. Ein
  // Zusammenlegen wuerde die Grenzen verwischen.
  //
  // Bis 2.6.3 lag die Zone als blasses breites Band auf der Fahrbahn.
  // Seit die Spuren versetzt sind, verschwand sie darunter - das Band
  // aus drei Spuren und Konturen ist breiter als die Zone selbst. Jetzt
  // laeuft die Zone auf der Spur ihres Rennens und tritt dort an die
  // Stelle der Linie, die zeichneStrecken() genau fuer diesen Abschnitt
  // ausspart. Sie ist deshalb kraeftig statt blass und etwas staerker
  // als die Linie: die Spur schwillt auf dem Zonenabschnitt an, und es
  // bleibt eindeutig, zu welchem Rennen sie gehoert.
  gruppen.forEach(g => {
    const a = markerArt(g.typ);
    if (!a.zone) return;
    g.eintraege.forEach(e => {
      if (e.m.sEnde === undefined || e.m.sEnde === null) return;
      const pts = gpxSlice(e.m.s, e.m.sEnde, e.raceId);
      if (pts.length > 1) {
        // So stark wie die weisse Kontur breit ist: die Zone fuellt die
        // Spur samt Rand aus. Dadurch schwillt die Spur sichtbar an und
        // verliert auf dem Abschnitt ihren weissen Saum - ein Signal,
        // das auch in der Uebersicht traegt, ohne in die Nachbarspur zu
        // ragen.
        const eigen = (typeof meinRaceId === 'function') && meinRaceId() === e.raceId;
        markerLayer.push(L.polyline(versetzteCoords(pts, gpxVersatz[e.raceId] || 0), {
          color: rennFarbe(e.raceId), weight: eigen ? 8 : 7, opacity: 0.9,
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
