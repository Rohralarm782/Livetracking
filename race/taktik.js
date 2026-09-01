// =======================
// TAKTIK
// =======================
const GROUP_COLORS = ['#EF9F27', '#378ADD', '#1D9E75', '#D85A30', '#7F77DD', '#888780'];
let lastPosData    = {};   // letzte Antwort von GET /positions
let displayTexts   = {};   // aktueller Text je Tracker
let displayAuto    = {};   // Tracker im Automatik-Modus
let displayPreview = '';   // Text, den die Automatik gerade erzeugen wuerde
let displayCfg     = { foreignNrs: 2, foreignNrsMaxSize: 6,
                       autoTextLeer: '' };
let displayMaxLen  = 60;   // Zeichenbudget, kommt vom Server
let taktikGroups   = [];
let taktikOpen     = false;
let splittingGid   = null;
const splitNrs     = new Set();
let mergingGid     = null;
let movingRider    = { gid: null, nr: null };
// Bis zu diesem Zeitpunkt darf pollGroups() den lokalen Stand NICHT
// ueberschreiben. Ohne die Sperre konnte der 5-Sekunden-Poll eine
// Antwort einspielen, die noch vor dem gerade abgeschickten Speichern
// erzeugt wurde - der naechste Klick auf +15 rechnete dann wieder vom
// alten Abstand aus und der Wert sprang zurueck.
let groupsWriteLock = 0;

// =======================
// EIGENE DATENQUELLE DES STREIFENS (ab 2.3.0)
// =======================
// Bis 2.2.0 zeigte der Streifen immer die Gruppen des Leitrennens -
// also des zuerst aktivierten, noch laufenden Rennens. Wer das zweite
// Rennen begleitet, sah damit dauerhaft die Taktik des ersten.
//
// Ab 2.3.0 holt der Streifen die Gruppen des eigenen Rennens
// (meinRaceId(), langes Tippen in der Rennleiste) ueber
// GET /groups?race=<id>. Dieser Stand ist ausdruecklich NUR ANZEIGE:
// taktikGroups bleibt unberuehrt, und damit bleibt auch der einzige
// Schreibweg (saveGroups -> POST /groups) auf dem Leitrennen. Ein
// Fremdstand in taktikGroups wuerde beim naechsten Speichern im
// Leitrennen landen - genau deshalb liegt er in einer eigenen
// Variablen.
let stripGroups = null;   // Gruppen des eigenen Rennens, nur lesend
let stripRaceId = null;   // wessen Gruppen gerade in stripGroups liegen

// Das Rennen, dessen Taktik zusaetzlich geholt werden muss - oder
// null, wenn das eigene Rennen ohnehin das Leitrennen ist. Dann bleibt
// alles beim Alten und es faellt kein zweiter Abruf an.
function stripFremdZiel() {
  if (typeof meinRaceId !== 'function') return null;
  const ziel = meinRaceId();
  const leit = (typeof activeInfo === 'object' && activeInfo) ? activeInfo.raceId : null;
  if (!ziel || !leit || ziel === leit) return null;
  return ziel;
}

// Gueltiger Fremdstand oder null. Bewusst streng: nur wenn die
// geladenen Gruppen wirklich zum aktuell gewaehlten Rennen gehoeren.
// Sonst faellt der Streifen auf das Leitrennen zurueck - und der Kopf
// beschriftet dann auch das Leitrennen. Lieber der andere Name als
// der falsche Name ueber echten Gruppen.
function stripFremdStand() {
  const ziel = stripFremdZiel();
  if (!ziel || ziel !== stripRaceId || !Array.isArray(stripGroups)) return null;
  return ziel;
}

async function loadStripGroups() {
  const ziel = stripFremdZiel();
  if (!ziel) { stripGroups = null; stripRaceId = null; return; }
  try {
    const res = await fetch(`${SERVER}/groups?race=${encodeURIComponent(ziel)}`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const next = await res.json();
    if (!Array.isArray(next)) throw new Error('Format');
    stripGroups = next;
    stripRaceId = ziel;
  } catch (e) {
    // Einen einzelnen Netzfehler soll der Streifen aushalten: der
    // letzte Stand desselben Rennens bleibt stehen. Nur ein Stand, der
    // zu einem ANDEREN Rennen gehoert, wird verworfen.
    if (stripRaceId !== ziel) { stripGroups = null; stripRaceId = null; }
  }
}

// Holen und zeichnen in einem Zug - fuer die Stellen, an denen der
// Nutzer die Auswahl gerade geaendert hat und nicht fuenf Sekunden auf
// den naechsten Poll warten soll.
function aktualisiereStrip() {
  loadStripGroups().then(() => {
    if (typeof renderStrip === 'function') renderStrip(taktikGroups);
  });
}

function openTaktikView() {
  taktikOpen = true;
  document.getElementById('taktikView').classList.remove('hidden');
  document.getElementById('taktikStrip').classList.add('hidden');
  closeOptionsMenu();
  if (eventsOpen) closeEventsPanel();   // immer auf der Taktik-Seite starten
  loadTaktikView();
}

function closeTaktikView() {
  taktikOpen = false;
  document.getElementById('taktikView').classList.add('hidden');
  renderStrip(taktikGroups);
}

document.getElementById('taktikBtn').addEventListener('click', openTaktikView);
document.getElementById('closeTaktikBtn').addEventListener('click', closeTaktikView);

async function loadTaktikView() {
  await loadGroups();
  await loadDisplays();
  await loadPending();
  if (authToken) await loadEvents();
  await loadGapSeries(true);
  if (taktikGroups.length === 0 && authToken) {
    taktikGroups.push({
      id:     'hauptfeld-' + Date.now().toString(36),
      name:   'Hauptfeld',
      color:  '#888780',
      gap:    null,
      main:   true,
      riders: []
    });
    await saveGroups();
  }
  renderTaktikBody();
}

async function loadDisplays() {
  try {
    const res  = await fetch(`${SERVER}/displays`);
    const data = await res.json();
    displayTexts   = data.texts   || {};
    displayAuto    = data.auto    || {};
    displayPreview = data.preview || '';
    if (data.settings) displayCfg = data.settings;
    if (data.maxLen)   displayMaxLen = data.maxLen;
  } catch (e) { console.error('Displays:', e); }
}

// Speichert beide Regler gemeinsam - der Server nimmt ohnehin nur
// das komplette Objekt entgegen.
async function saveDisplaySettings() {
  if (!authToken) return;
  const read = key => {
    const el = document.querySelector(`.ds-inp[data-key="${key}"]`);
    return el ? parseInt(el.value) : displayCfg[key];
  };
  // Der Vorgabetext ist keine Zahl - parseInt() daraus waere NaN und
  // der Server bekaeme sein eigenes Feld nie zu sehen.
  const readText = key => {
    const el = document.querySelector(`.ds-inp[data-key="${key}"]`);
    return el ? el.value : displayCfg[key];
  };
  const body = {
    foreignNrs:        read('foreignNrs'),
    foreignNrsMaxSize: read('foreignNrsMaxSize'),
    autoTextLeer:      readText('autoTextLeer')
  };
  try {
    const res = await fetch(`${SERVER}/display-settings`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body:    JSON.stringify(body)
    });
    if (!res.ok) { alert('\u274C Einstellungen konnten nicht gespeichert werden'); return; }
  } catch (err) { alert('\u274C Fehler: ' + err.message); return; }
  await loadDisplays();
  renderTaktikBody();
}

async function toggleAuto(id) {
  const on = !displayAuto[id];
  try {
    const res = await fetch(`${SERVER}/display-auto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ id, auto: on })
    });
    if (!res.ok) { alert('\u274C Umschalten fehlgeschlagen'); return; }
    if (on) displayAuto[id] = true; else delete displayAuto[id];
    await loadDisplays();
    renderTaktikBody();
  } catch (err) { alert('\u274C Fehler: ' + err.message); }
}

async function loadGroups() {
  try {
    const res  = await fetch(`${SERVER}/groups`);
    taktikGroups = await res.json();
  } catch (e) { console.error('Groups:', e); }
}

// =======================
// RUECKGAENGIG (nur Gruppen)
// =======================
// Ein einziger Ankerpunkt statt einer Zeile in jeder Aktion:
// saveGroups() ist der Engpass, durch den jede Gruppenaenderung geht.
// Der Stapel bekommt den Stand VOR der Aenderung - also den, der beim
// letzten Speichern gueltig war.
const UNDO_MAX = 20;
let undoStack     = [];
let lastSaved     = null;    // Stand nach dem letzten eigenen Speichern
let undoRestoring = false;   // waehrend des Zurueckrollens nichts stapeln

function groupsKopie(gs) {
  return (gs || []).map(g => ({
    id: g.id, name: g.name, color: g.color,
    gap: g.gap || null, gapPrev: g.gapPrev || null, main: g.main === true,
    riders: (g.riders || []).map(r => (r && typeof r === 'object') ? r.nr : r)
  }));
}

function groupsSchluessel(gs) { return JSON.stringify(groupsKopie(gs)); }

// Beschriftung aus dem Vergleich ableiten statt aus jedem Aufrufer.
// Spart 10 Einzelpatches und kann nie danebenliegen, weil sie aus dem
// tatsaechlichen Unterschied kommt.
function undoLabel(alt, neu) {
  if (!alt) return 'Aenderung';
  if (neu.length > alt.length) return 'Gruppe angelegt';
  if (neu.length < alt.length) return 'Gruppe entfernt';
  const zahl = gs => gs.reduce((n, g) => n + g.riders.length, 0);
  if (zahl(neu) !== zahl(alt))                                   return 'Fahrer verschoben';
  // Hauptfeld vor Umbenannt: das Umsetzen des Markers zieht seit der
  // automatischen Benennung immer auch Namenswechsel nach sich. Stuende
  // Umbenannt weiter oben, hiesse jeder HF-Wechsel im Undo 'Umbenannt'.
  if (neu.some((g, i) => g.main  !== alt[i].main))               return 'Hauptfeld';
  if (neu.some((g, i) => g.gap   !== alt[i].gap))                return 'Abstand';
  if (neu.some((g, i) => g.name  !== alt[i].name))               return 'Umbenannt';
  if (groupsSchluessel(neu) !== groupsSchluessel(alt))           return 'Fahrer verschoben';
  return 'Aenderung';
}

function undoMoeglich() { return undoStack.length > 0; }

async function undoLast() {
  if (!undoStack.length || !authToken) return;
  const eintrag = undoStack.pop();
  undoRestoring = true;
  taktikGroups  = groupsKopie(eintrag.groups);
  const ok = await saveGroups();
  undoRestoring = false;
  if (ok) { lastSaved = groupsSchluessel(taktikGroups); showToast('\u21B6 ' + eintrag.label); }
  else    { undoStack.push(eintrag); }   // nicht gespeichert -> Schritt behalten
  renderTaktikBody(); renderStrip(taktikGroups);
}

// =======================
// AUTOMATISCHE GRUPPENBENENNUNG
// =======================
// Der Name folgt der Fahrreihenfolge, nicht umgekehrt: Position im
// Array im Verhaeltnis zum Hauptfeld bestimmt, wie eine Gruppe heisst.
// Damit stimmt der Name nach jedem Aufteilen, Zusammenfuehren und
// Umsetzen des HF-Markers von selbst.
//
// Ein eigenes Feld 'manuell benannt' waere der naheliegende Weg -
// scheitert aber daran, dass sanitizeGroups() im Server nur
// {id,name,color,gap,gapPrev,main,riders} durchlaesst und alles
// weitere stillschweigend verwirft. Stattdessen wird die Herkunft aus
// dem Namen selbst abgeleitet: was die Automatik je vergeben hat,
// darf sie auch wieder ueberschreiben. Alles andere ist von Hand
// gesetzt und bleibt unangetastet.
const AUTO_NAME_RE  = /^(Hauptfeld|Spitzengruppe|Verfolger|Gruppetto|Gruppe) ?\d*$/;
// Namen, die frueher automatisch vergeben wurden: der namePool aus
// confirmSplit() und der Platzhalter aus addGroup(). Ohne sie blieben
// laufende Rennen auf ihren alten Namen stehen.
const AUTO_NAME_ALT = [
  'Ausr\u00FC\u00DFer', 'Spitze 2', 'Vorne',
  'Nachz\u00FCgler', 'Feld 2', 'Hinten', 'Neue Gruppe'
];

function istAutoName(name) {
  const n = String(name === undefined || name === null ? '' : name).trim();
  if (n === '') return true;
  return AUTO_NAME_RE.test(n) || AUTO_NAME_ALT.indexOf(n) >= 0;
}

// Setzt die Namen neu und liefert zurueck, wie viele sich geaendert
// haben. Die Ziffer kommt erst, wenn ein Abschnitt mehr als eine
// Gruppe hat: bei genau einem Verfolger ist 'Verfolger 1' eine
// Nummerierung ohne Reihe.
function benenneGruppenNeu() {
  const mi       = mainGroupIdx();
  const vorZahl  = Math.max(0, mi - 1);                        // zwischen Spitze und HF
  const nachZahl = Math.max(0, taktikGroups.length - 1 - mi);  // hinter dem HF
  let vi = 0, gi = 0, geaendert = 0;
  taktikGroups.forEach((g, i) => {
    if (!g || typeof g !== 'object') return;
    let soll;
    if      (i === mi) soll = 'Hauptfeld';
    else if (i >  mi)  { gi++; soll = nachZahl > 1 ? 'Gruppetto ' + gi : 'Gruppetto'; }
    else if (i === 0)  soll = 'Spitzengruppe';
    else               { vi++; soll = vorZahl  > 1 ? 'Verfolger ' + vi : 'Verfolger'; }
    if (!istAutoName(g.name)) return;      // von Hand benannt: in Ruhe lassen
    if (g.name !== soll) { g.name = soll; geaendert++; }
  });
  return geaendert;
}

async function saveGroups() {
  if (!authToken) return;
  // Vor dem Undo-Schnappschuss, damit die neuen Namen zum gespeicherten
  // Stand gehoeren und nicht als eigener Schritt danebenstehen.
  // Beim Zurueckrollen ausgelassen: sonst wuerde die Automatik den
  // gerade zurueckgeholten Stand sofort wieder ueberschreiben.
  const umbenannt = undoRestoring ? 0 : benenneGruppenNeu();
  if (!undoRestoring) {
    const neu = groupsSchluessel(taktikGroups);
    if (lastSaved !== null && lastSaved !== neu) {
      undoStack.push({ groups: JSON.parse(lastSaved), label: undoLabel(JSON.parse(lastSaved), groupsKopie(taktikGroups)) });
      if (undoStack.length > UNDO_MAX) undoStack.shift();
    }
  }
  groupsWriteLock = Date.now() + 4000;
  const payload = taktikGroups.map(g => ({
    id:      g.id,
    name:    g.name,
    color:   g.color,
    gap:     g.gap    || null,
    gapPrev: g.gapPrev || null,
    main:    g.main === true,
    riders:  (g.riders || []).map(r => typeof r === 'object' ? r.nr : r)
  }));
  // Der Status wurde bisher nicht geprueft. Lief das Speichern in ein
  // 403, blieb die Aenderung nur lokal stehen und pollGroups() hat sie
  // fuenf Sekunden spaeter stillschweigend ueberschrieben - mitten im
  // Rennen und ohne jeden Hinweis.
  let ok = false;
  try {
    const res = await fetch(`${SERVER}/groups`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body:    JSON.stringify({ groups: payload })
    });
    ok = res.ok;
    if (!res.ok) checkAuth(res);
  } catch (e) { console.error('saveGroups:', e); }

  if (!ok) {
    // Sperre sofort aufheben, damit der naechste Poll den echten
    // Serverstand zurueckholt statt den nicht gespeicherten zu halten.
    groupsWriteLock = 0;
    showToast('\u26A0\uFE0F Taktik nicht gespeichert');
    return false;
  }
  // Kurze Nachlaufzeit: der naechste Poll soll erst laufen, wenn der
  // Server den neuen Stand sicher ausliefert.
  groupsWriteLock = Date.now() + 800;
  lastSaved = groupsSchluessel(taktikGroups);
  // Nur melden, wenn wirklich ein Name gewechselt hat. Beim blossen
  // Fahrerschieben aendert sich keiner, da waere der Hinweis Laerm.
  if (umbenannt > 0) showToast('\u270E Gruppen neu benannt');
  return true;
}

// Index der Hauptfeld-Gruppe. Gleiche Regel wie im Server:
// ausdruecklicher Marker, sonst die letzte Gruppe.
function mainGroupIdx() {
  const i = taktikGroups.findIndex(g => g && g.main === true);
  return i >= 0 ? i : taktikGroups.length - 1;
}

// Der Marker ist jederzeit umsetzbar, nicht einmalig: genau eine
// Gruppe traegt ihn, ein Klick verschiebt ihn.
async function setMainGroup(gid) {
  if (!authToken) return;
  taktikGroups.forEach(g => { g.main = (g.id === gid); });
  await saveGroups();
  renderTaktikBody(); renderStrip(taktikGroups);
}

// Reihenfolge beim Durchtippen. Ein Tippen weiter, ein Tippen zurueck
// auf normal - im Auto ist ein Menue mit vier Punkten unbedienbar.
const RIDER_STATE_CYCLE = [null, 'warn', 'dsq', 'dnf'];

const RIDER_STATE_LABEL = {
  warn: { txt: '\u26A0',  title: 'Verwarnt',            bg: '#fff8e1', fg: '#f57f17', bd: '#ffe082' },
  dsq:  { txt: 'DSQ', title: 'Disqualifiziert',      bg: '#ffebee', fg: '#c62828', bd: '#ef9a9a' },
  dnf:  { txt: 'DNF', title: 'Aufgegeben',           bg: '#eceff1', fg: '#546e7a', bd: '#cfd8dc' }
};

// Zustand eines Fahrers weiterschalten: normal -> verwarnt -> DSQ ->
// DNF -> normal. DSQ und DNF nehmen den Fahrer aus der Gruppengroesse
// und von den Garmin-Anzeigen, er bleibt in der Gruppe aber sichtbar.
async function cycleRiderStatus(nr, current) {
  if (!authToken || !activeRaceId) return;
  const idx  = RIDER_STATE_CYCLE.indexOf(current || null);
  const next = RIDER_STATE_CYCLE[(idx < 0 ? 0 : idx + 1) % RIDER_STATE_CYCLE.length];
  try {
    await setRiderStatus(activeRaceId, nr, next);
  } catch (err) { alert('\u274C ' + err.message); return; }
  await loadGroups();
  await loadDisplays();
  if (favModalOpen) await renderFavModal();
  renderTaktikBody();
}

// =======================
// ABSTANDSVERLAUF
// =======================
// gap_history wurde bisher nur geschrieben. Daraus laesst sich die
// Annaeherungsrate ablesen - die eigentlich interessante Zahl:
// nicht "1:30 Rueckstand", sondern "holt 8 s pro Minute auf".
let gapSeries    = Object.create(null);   // gid -> [{ t, sec }]
let gapLoadedAt  = 0;
const GAP_WINDOW_MS  = 6 * 60 * 1000;     // Betrachtungsfenster
const GAP_RELOAD_MS  = 30 * 1000;         // hoechstens alle 30 s laden

async function loadGapSeries(force) {
  if (!activeRaceId) { gapSeries = Object.create(null); return; }
  if (!force && Date.now() - gapLoadedAt < GAP_RELOAD_MS) return;
  gapLoadedAt = Date.now();
  // Zeitfenster gleich mitgeben, damit der Server nur liefert, was hier
  // ausgewertet wird. Eine Minute Zugabe gegen Uhrenversatz.
  const snaps = await loadRaceGaps(activeRaceId, Math.ceil(GAP_WINDOW_MS / 60000) + 1);
  const out   = Object.create(null);
  const cut   = Date.now() - GAP_WINDOW_MS;
  snaps.forEach(s => {
    if (!s || s.ts < cut || !Array.isArray(s.groups)) return;
    s.groups.forEach(g => {
      if (!g || !g.id) return;
      const sec = gapToSec(g.gap);
      if (sec === null) return;
      (out[g.id] = out[g.id] || []).push({ t: s.ts, sec });
    });
  });
  gapSeries = out;
}

// Sekunden pro Minute. Negativ = holt auf. null, wenn die Datenlage
// zu duenn ist - lieber nichts anzeigen als eine Zahl erfinden.
function gapRate(gid) {
  const s = gapSeries[gid];
  if (!s || s.length < 2) return null;
  const a = s[0], b = s[s.length - 1];
  const min = (b.t - a.t) / 60000;
  if (min < 1) return null;
  return (b.sec - a.sec) / min;
}

// Favorit umschalten. Geht nur fuer Fahrer, die in der Startliste
// stehen - dort liegt die Markierung.
async function toggleFav(nr, on) {
  if (!authToken || !activeRaceId) return;
  try {
    const res = await fetch(`${SERVER}/races/${activeRaceId}/favorite`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body:    JSON.stringify({ nr, fav: on })
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert('\u274C ' + (d.error || 'Favorit konnte nicht gesetzt werden'));
      return;
    }
  } catch (err) { alert('\u274C Fehler: ' + err.message); return; }
  await loadGroups();
  await loadDisplays();
  if (favModalOpen) await renderFavModal();
  renderTaktikBody();
}

async function addGroup() {
  // Vor das Hauptfeld: neue Gruppen sind Ausreisser oder Verfolger,
  // hinter dem Feld wuerden sie den Text abschneiden.
  // Der Name kommt nicht mehr aus einer festen Liste, sondern aus der
  // Fahrreihenfolge: benenneGruppenNeu() ersetzt den Platzhalter noch
  // im selben saveGroups(). Die alte Liste lag ab der dritten Gruppe
  // ohnehin daneben ('Gruppe 3' mitten im Feld).
  const insertIdx  = Math.max(0, mainGroupIdx());
  taktikGroups.splice(insertIdx, 0, {
    id:     Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
    name:   'Gruppe',
    color:  GROUP_COLORS[insertIdx % GROUP_COLORS.length],
    gap:    null,
    riders: []
  });
  await saveGroups();
  renderTaktikBody();
  renderStrip(taktikGroups);
}

async function deleteGroup(gid) {
  // Der Papierkorb sitzt in der Fusszeile direkt neben "+ Fahrer".
  // Ein Fehlgriff hat bisher ohne Rueckfrage eine komplette Gruppe
  // samt Fahrern geloescht.
  const grp = taktikGroups.find(g => g.id === gid);
  const cnt = grp ? (grp.riders || []).length : 0;
  if (cnt > 0 && !confirm(`Gruppe \u201E${grp.name}\u201C mit ${cnt} Fahrer${cnt === 1 ? '' : 'n'} l\u00F6schen?`)) return;
  taktikGroups = taktikGroups.filter(g => g.id !== gid);
  await saveGroups();
  renderTaktikBody();
  renderStrip(taktikGroups);
}

function startSplit(gid) { splittingGid = gid; splitNrs.clear(); renderTaktikBody(); }
function cancelSplit()    { splittingGid = null; splitNrs.clear(); renderTaktikBody(); }

async function confirmSplit(gid, direction = 'before') {
  if (splitNrs.size === 0) { alert('Keine Fahrer ausgew\u00E4hlt'); return; }
  const g = taktikGroups.find(g => g.id === gid);
  if (!g) return;
  const nr = r => r.nr !== undefined ? r.nr : r;
  const splitRiders  = (g.riders||[]).filter(r =>  splitNrs.has(nr(r)));
  const remainRiders = (g.riders||[]).filter(r => !splitNrs.has(nr(r)));
  g.riders = remainRiders;
  // Der namePool entfaellt: welche Gruppe wie heisst, entscheidet nach
  // dem Aufteilen die Position, nicht die Reihenfolge der Klicks.
  // Die Farbwahl bleibt wie sie war.
  const usedCols = taktikGroups.map(g => g.color);
  const newColor = GROUP_COLORS.find(c => !usedCols.includes(c)) || GROUP_COLORS[0];
  const insertIdx = taktikGroups.indexOf(g) + (direction === 'after' ? 1 : 0);
  // gap meint immer den Rueckstand auf die Gruppe DAVOR. Setzt sich
  // eine Gruppe nach vorne ab, ruecken die Abgesetzten an die Stelle
  // der alten Gruppe: sie erben deren Abstand, und der Rest hat auf
  // die Abgesetzten erstmal keinen messbaren Rueckstand.
  // Ohne das behielt die Restgruppe einen Abstand, der sich auf eine
  // ganz andere Gruppe bezog - und stand so auch auf dem Garmin.
  const newGap = direction === 'before' ? (g.gap || null) : null;
  if (direction === 'before') { g.gapPrev = g.gap; g.gap = null; }
  taktikGroups.splice(insertIdx, 0, {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
    name: 'Gruppe', color: newColor, gap: newGap, riders: splitRiders
  });
  splittingGid = null; splitNrs.clear();
  await saveGroups(); await loadGroups();
  renderTaktikBody(); renderStrip(taktikGroups);
}

function gapToSec(s) {
  if (!s) return null;
  const m = s.match(/^(\d+):(\d{2})$/);
  if (m) return parseInt(m[1]) * 60 + parseInt(m[2]);
  const n = parseInt(s);
  return isNaN(n) ? null : n;
}
function secToGap(s) {
  if (s <= 0) return '0:00';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function trendArrow(cur, prev) {
  const c = gapToSec(cur), p = gapToSec(prev);
  if (c === null || p === null || c === p) return '';
  return c > p
    ? '<span style="color:#e53935;font-size:10px">\u2191</span>'
    : '<span style="color:#2e7d32;font-size:10px">\u2193</span>';
}
function adjustGap(gid, deltaSec) {
  const g = taktikGroups.find(g => g.id === gid);
  if (!g || !authToken) return;
  const newSec = Math.max(0, (gapToSec(g.gap) || 0) + deltaSec);
  g.gapPrev = g.gap;
  g.gap = newSec > 0 ? secToGap(newSec) : null;
  saveGroups(); renderTaktikBody(); renderStrip(taktikGroups);
}

function startMerge(gid)  { mergingGid = gid; splittingGid = null; splitNrs.clear(); movingRider = { gid: null, nr: null }; renderTaktikBody(); }
function cancelMerge()    { mergingGid = null; renderTaktikBody(); }

async function confirmMerge(sourceGid, targetGid) {
  const src = taktikGroups.find(g => g.id === sourceGid);
  const tgt = taktikGroups.find(g => g.id === targetGid);
  if (!src || !tgt) return;
  tgt.riders = [...(tgt.riders||[]), ...(src.riders||[])];
  taktikGroups = taktikGroups.filter(g => g.id !== sourceGid);
  mergingGid = null;
  await saveGroups(); await loadGroups();
  renderTaktikBody(); renderStrip(taktikGroups);
}

function startMoveRider(gid, nr)  { movingRider = { gid, nr }; splittingGid = null; splitNrs.clear(); mergingGid = null; renderTaktikBody(); }
function cancelMoveRider()        { movingRider = { gid: null, nr: null }; renderTaktikBody(); }

async function confirmMoveRider(targetGid) {
  const { gid: srcGid, nr } = movingRider;
  const src = taktikGroups.find(g => g.id === srcGid);
  const tgt = taktikGroups.find(g => g.id === targetGid);
  if (!src || !tgt) return;
  src.riders = (src.riders||[]).filter(r => (r.nr !== undefined ? r.nr : r) !== nr);
  tgt.riders = [...(tgt.riders||[]), nr];
  movingRider = { gid: null, nr: null };
  await saveGroups(); await loadGroups();
  renderTaktikBody(); renderStrip(taktikGroups);
}

async function addRider(gid) {
  const inp = document.querySelector(`.add-rider-input[data-gid="${gid}"]`);
  if (!inp) return;
  const nr = parseInt(inp.value);
  if (isNaN(nr) || nr < 1) return;
  if (taktikGroups.some(g => (g.riders||[]).some(r => (r.nr||r) === nr))) {
    alert(`Nr. ${nr} ist bereits in einer Gruppe`); return;
  }
  const g = taktikGroups.find(g => g.id === gid);
  if (!g) return;
  if (!g.riders) g.riders = [];
  g.riders.push(nr);
  await saveGroups(); await loadGroups();
  renderTaktikBody(); renderStrip(taktikGroups);
  const refocus = document.querySelector(`.add-rider-input[data-gid="${gid}"]`);
  if (refocus) { refocus.value = ''; refocus.focus(); }
}

async function removeRider(gid, nr) {
  const g = taktikGroups.find(g => g.id === gid);
  if (!g) return;
  g.riders = (g.riders||[]).filter(r => (r.nr||r) !== nr);
  await saveGroups(); await loadGroups();
  renderTaktikBody(); renderStrip(taktikGroups);
}

// Frueher standen hier neuesRennen(), activateStartlist() und
// deleteStartlist(). Ersetzt durch:
//   - Rennen aktivieren/loeschen  -> race/events-ui.js
//   - Gruppen zuruecksetzen       -> passiert beim Rennenwechsel selbst
//   - Positionen/Karte leeren     -> clearMap() in map/map.js
//                                    ("Karte leeren", erweiterte Einstellungen)
