// =======================
// TAKTIK
// =======================
const GROUP_COLORS = ['#EF9F27', '#378ADD', '#1D9E75', '#D85A30', '#7F77DD', '#888780'];
let lastPosData    = {};   // letzte Antwort von GET /positions
let displayTexts   = {};   // aktueller Text je Tracker
let displayAuto    = {};   // Tracker im Automatik-Modus
let displayPreview = '';   // Text, den die Automatik gerade erzeugen wuerde
let displayCfg     = { foreignNrs: 2, foreignNrsMaxSize: 6 };
let displayMaxLen  = 60;   // Zeichenbudget, kommt vom Server
let taktikGroups   = [];
let taktikOpen     = false;
let splittingGid   = null;
const splitNrs     = new Set();
let mergingGid     = null;
let movingRider    = { gid: null, nr: null };

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
  const body = {
    foreignNrs:        read('foreignNrs'),
    foreignNrsMaxSize: read('foreignNrsMaxSize')
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

async function saveGroups() {
  if (!authToken) return;
  const payload = taktikGroups.map(g => ({
    id:      g.id,
    name:    g.name,
    color:   g.color,
    gap:     g.gap    || null,
    gapPrev: g.gapPrev || null,
    main:    g.main === true,
    riders:  (g.riders || []).map(r => typeof r === 'object' ? r.nr : r)
  }));
  await fetch(`${SERVER}/groups`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
    body:    JSON.stringify({ groups: payload })
  }).catch(e => console.error('saveGroups:', e));
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
  const insertIdx  = Math.max(0, mainGroupIdx());
  const names      = ['Spitzengruppe', 'Verfolger'];
  taktikGroups.splice(insertIdx, 0, {
    id:     Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
    name:   names[insertIdx] || ('Gruppe ' + (insertIdx + 1)),
    color:  GROUP_COLORS[insertIdx % GROUP_COLORS.length],
    gap:    null,
    riders: []
  });
  await saveGroups();
  renderTaktikBody();
  renderStrip(taktikGroups);
}

async function deleteGroup(gid) {
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
  const used     = taktikGroups.map(g => g.name);
  const namePool = direction === 'before'
    ? ['Spitzengruppe','Ausr\u00FC\u00DFer','Spitze 2','Vorne']
    : ['Verfolger','Nachz\u00FCgler','Feld 2','Hinten'];
  const newName  = namePool.find(n => !used.includes(n)) || 'Neue Gruppe';
  const usedCols = taktikGroups.map(g => g.color);
  const newColor = GROUP_COLORS.find(c => !usedCols.includes(c)) || GROUP_COLORS[0];
  const insertIdx = taktikGroups.indexOf(g) + (direction === 'after' ? 1 : 0);
  taktikGroups.splice(insertIdx, 0, {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
    name: newName, color: newColor, gap: null, riders: splitRiders
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
