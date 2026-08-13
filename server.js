const express = require('express');
const cors    = require('cors');
const mqtt    = require('mqtt');
const fs      = require('fs');
const path    = require('path');
const db      = require('./db');

const app = express();

// =======================
// MIDDLEWARE
// =======================
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  console.log(`➡️ ${req.method} ${req.url}`);
  next();
});

// =======================
// FRONTEND
// =======================
app.use(express.static(__dirname));

// =======================
// STATE
// =======================
let positions = Object.create(null);
let currentMode = 'race'; // 'race' | 'training'

// Hardware-ID → Anzeigename; bleibt bei /positions DELETE erhalten
const trackerDisplayNames = Object.create(null);

// Tracker, die sich gemeldet haben, aber noch keinen GPS-Fix haben.
// id -> { since, timestamp, sats }
//   since     = erste Meldung DIESER Suchphase (fuer die Laufzeit-Anzeige)
//   timestamp = letzte Meldung (fuer den Timeout)
// Bewusst getrennt von positions{}: dort haengt die komplette Karten-
// und Marker-Logik dran, die mit einem Eintrag ohne lat/lon nichts
// anfangen kann.
const pending            = Object.create(null);
const PENDING_TIMEOUT_MS = 90000;

// Aktuell auf den Garmin-Displays stehende Texte, je Tracker-ID.
// Quelle der Wahrheit ist der Broker (retained) - wir lesen sie beim
// Verbinden zurueck und ueberleben damit auch einen Cold Start.
const displayTexts = Object.create(null);

// Tracker im Automatik-Modus: Text wird aus den Gruppen gebaut.
// id -> true. Fehlt der Eintrag, gilt manuell.
const autoDisplay = Object.create(null);

// Max. 60 Zeichen - passt unter die ausgehandelte BLE-MTU.
// Muss mit DISPLAY_MAX in der Firmware uebereinstimmen.
const DISPLAY_MAX = 60;

// Einstellungen fuer den Automatik-Text. Zahlen statt Schalter:
// 0 schaltet die jeweilige Zeile ohne Sonderfall ab.
//   foreignNrs        Fremdnummern je Gruppe, hoechstens
//   foreignNrsMaxSize ab dieser Gruppengroesse gar keine Fremdnummern
//                     mehr - drei von zwanzig Nummern sind keine
//                     Information. Favoriten sind davon ausgenommen.
let displaySettings = { foreignNrs: 2, foreignNrsMaxSize: 6 };

function sanitizeSettings(s) {
  const clamp = (v, def, max) => {
    const n = parseInt(v);
    return (isNaN(n) || n < 0) ? def : Math.min(n, max);
  };
  return {
    foreignNrs:        clamp(s && s.foreignNrs,        displaySettings.foreignNrs,        5),
    foreignNrsMaxSize: clamp(s && s.foreignNrsMaxSize, displaySettings.foreignNrsMaxSize, 99)
  };
}

// Nur druckbares ASCII: Umlaute oder Emoji wuerden auf dem
// Garmin als leere Kaestchen erscheinen.
function sanitizeDisplay(text) {
  let out = '';
  const src = String(text == null ? '' : text);
  for (let i = 0; i < src.length && out.length < DISPLAY_MAX; i++) {
    const c = src.charCodeAt(i);
    if (c >= 32 && c <= 126) out += src[i];
  }
  return out.trim();
}

// Index der Hauptfeld-Gruppe. Vorrang hat die ausdrueckliche Markierung
// (main: true), sonst gilt wie bisher die letzte Gruppe. Damit bleibt
// der Text auch fuer alte Rennen ohne Marker richtig.
function mainGroupIndex() {
  const i = groups.findIndex(g => g && g.main === true);
  return i >= 0 ? i : groups.length - 1;
}

// Startnummern der Favoriten des aktiven Rennens.
// Quelle ist die Startliste - ein Fahrer ohne Startlisten-Eintrag
// kann kein Favorit sein.
function favNrs() {
  const s = new Set();
  if (!activeRaceId || !races[activeRaceId]) return s;
  for (const r of races[activeRaceId].riders) {
    if (r && r.fav && r.nr !== undefined && r.nr !== null) s.add(Number(r.nr));
  }
  return s;
}

// Baut den Anzeigetext aus dem aktuellen Gruppenstand.
// Format je Gruppe: "<Anzahl>x <Abstand nach hinten>~<Startnummern>"
// Das 'x' klebt an der Zahl und macht sie als Stueckzahl kenntlich -
// ohne das liest sich "6 0:15" wie zwei gleichrangige Zahlen.
// Muss ASCII bleiben: bytesToLines() im Datenfeld filtert auf 32-126,
// ein typografisches Mal-Zeichen wuerde stillschweigend verschluckt.
//
// Das Hauptfeld heisst "HF" und beendet den Text:
//   - ohne Anzahl, weil wir nicht zaehlen, wer hinten rausfaellt
//   - ohne Abstand, weil der Abstand einer Gruppe der nach hinten ist
//   - Gruppen dahinter (Gruppetto) entfallen ganz
// "HF" ersetzt damit das frueher angehaengte "...".
//
// Der Abstand steht in groups[i].gap und meint den Rueckstand
// AUF DIE GRUPPE DAVOR. Fuer "Abstand nach hinten" brauchen
// wir daher den gap der FOLGENDEN Gruppe.
//
// Reicht das Zeichenbudget nicht, wird gestuft gekuerzt statt hinten
// abgeschnitten. Reihenfolge: Fremdnummern von hinten nach vorn,
// dann Favoriten von hinten nach vorn. Die Kopfzeilen bleiben.
function buildAutoText() {
  if (!Array.isArray(groups) || groups.length === 0) return '';

  const mainIdx = mainGroupIndex();
  const favs    = favNrs();
  const maxFor  = displaySettings.foreignNrs;
  const maxSize = displaySettings.foreignNrsMaxSize;

  // Segmente bis einschliesslich Hauptfeld
  const segs = [];
  for (let i = 0; i <= mainIdx && i < groups.length; i++) {
    const g      = groups[i];
    const riders = (Array.isArray(g.riders) ? g.riders : [])
      .map(r => (r && r.nr !== undefined) ? Number(r.nr) : Number(r))
      .filter(n => !isNaN(n));

    let head;
    if (i === mainIdx) {
      head = 'HF';
    } else {
      const next = groups[i + 1];
      const gap  = next && next.gap ? String(next.gap).trim() : '';
      head = String(riders.length) + 'x' + (gap.length > 0 ? ' ' + gap : '');
    }

    // Im Hauptfeld sind Fremdnummern wertlos: wir fuehren dort keine
    // vollstaendige Liste, zwei herausgegriffene Nummern taeuschen
    // eine Information vor, die es nicht gibt. Favoriten dagegen sind
    // genau die Aussage "dein Fahrer sitzt im Feld".
    const fav     = riders.filter(n =>  favs.has(n));
    const other   = riders.filter(n => !favs.has(n));
    const tooBig  = (maxSize > 0 && riders.length > maxSize);
    const foreign = (i === mainIdx || tooBig) ? [] : other.slice(0, maxFor);
    segs.push({ head, fav, foreign });
  }

  // Komma statt Leerzeichen zwischen den Nummern: in der kleinen
  // Schrift der optionalen Zeile ist ein Leerzeichen zu schmal,
  // "8 9" liest sich sonst als "89". Kostet kein Zeichen mehr.
  const keepFav = segs.map(s => s.fav.length);
  const keepFor = segs.map(s => s.foreign.length);
  const render  = () => segs.map((s, i) => {
    const nrs = s.fav.slice(0, keepFav[i]).concat(s.foreign.slice(0, keepFor[i]));
    return s.head + (nrs.length > 0 ? '~' + nrs.join(',') : '');
  }).join(';');

  // Streichreihenfolge aufbauen: niedrigste Prioritaet zuerst.
  const drop = [];
  for (let i = segs.length - 1; i >= 0; i--)
    for (let k = 0; k < segs[i].foreign.length; k++) drop.push(['for', i]);
  for (let i = segs.length - 1; i >= 0; i--)
    for (let k = 0; k < segs[i].fav.length; k++) drop.push(['fav', i]);

  let out = render();
  let d   = 0;
  while (out.length > DISPLAY_MAX && d < drop.length) {
    const [kind, i] = drop[d++];
    if (kind === 'for') keepFor[i]--; else keepFav[i]--;
    out = render();
  }

  // Passen nicht einmal die Kopfzeilen, fallen Gruppen direkt vor dem
  // Hauptfeld weg: vorne stehen die Ausreisser, hinten der Anker.
  // Braucht es ab etwa acht Gruppen - im Rennen praktisch nie.
  while (out.length > DISPLAY_MAX && segs.length > 2) {
    segs.splice(segs.length - 2, 1);
    keepFav.splice(keepFav.length - 2, 1);
    keepFor.splice(keepFor.length - 2, 1);
    out = render();
  }

  return sanitizeDisplay(out);
}

// Automatik-Tracker mit dem aktuellen Stand versorgen.
// Publiziert nur bei echter Aenderung - sonst produziert jeder
// Taktik-Klick Funkverkehr auf allen Trackern.
function pushAutoDisplays() {
  if (!mqttClient || !mqttClient.connected) return;
  const text = buildAutoText();
  for (const id of Object.keys(autoDisplay)) {
    if (!autoDisplay[id]) continue;
    if (displayTexts[id] === text) continue;
    mqttClient.publish(`livetracking-fq4l/display/${id}`, text, { retain: true, qos: 0 });
    if (text.length > 0) displayTexts[id] = text;
    else                 delete displayTexts[id];
    console.log(`\u{1F916} Auto ${id} \u2192 "${text}"`);
  }
}

// =======================
// VERANSTALTUNGEN & RENNEN
// =======================
// Ein Rennen gehoert zu genau einer Veranstaltung und traegt seine
// Startliste (riders) sowie seinen Taktik-Stand (groups) selbst.
// Rennen ohne echte Veranstaltung landen im Sammel-Event FALLBACK_EVENT.
//
// Quelle der Wahrheit ist die Datenbank. Die Disk-Datei wird nur noch
// ohne DATABASE_URL geschrieben - sonst haetten wir zwei Quellen.
const RACES_FILE     = path.join(__dirname, 'races.json');
const LEGACY_FILE    = path.join(__dirname, 'startlists.json');
const FALLBACK_EVENT = 'archiv';

let events       = Object.create(null);   // id -> Veranstaltung
let races        = Object.create(null);   // id -> Rennen
let activeRaceId = null;

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

// Fehlende Felder auffuellen: alte Disk-Startlisten kennen nur
// id/name/createdAt/riders.
function normalizeRace(r) {
  return {
    id:        r.id,
    eventId:   r.eventId || FALLBACK_EVENT,
    name:      r.name,
    category:  r.category  || null,
    startTime: r.startTime || null,
    status:    r.status    || 'geplant',
    createdAt: r.createdAt || new Date().toISOString(),
    riders:    Array.isArray(r.riders) ? r.riders : [],
    groups:    Array.isArray(r.groups) ? r.groups : [],
    // {coords:[[lat,lon],...], name} oder null - gehoert zum Rennen
    gpx:       (r.gpx && Array.isArray(r.gpx.coords) && r.gpx.coords.length) ? r.gpx : null
  };
}

// Sammelbecken fuer Rennen ohne echte Veranstaltung.
function ensureFallbackEvent() {
  if (events[FALLBACK_EVENT]) return events[FALLBACK_EVENT];
  events[FALLBACK_EVENT] = {
    id:        FALLBACK_EVENT,
    name:      'Ohne Veranstaltung',
    ort:       null,
    dateFrom:  null,
    dateTo:    null,
    createdAt: new Date().toISOString()
  };
  if (db.enabled) db.upsertEvent(events[FALLBACK_EVENT]).catch(dbFail('upsertEvent fallback'));
  return events[FALLBACK_EVENT];
}

function loadRacesFromDisk() {
  try {
    const file = fs.existsSync(RACES_FILE)  ? RACES_FILE
               : fs.existsSync(LEGACY_FILE) ? LEGACY_FILE
               : null;
    if (!file) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    events = raw.events || Object.create(null);
    // raw.lists = altes Format aus startlists.json
    const src = raw.races || raw.lists || Object.create(null);
    races = Object.create(null);
    for (const r of Object.values(src)) races[r.id] = normalizeRace(r);
    activeRaceId = (raw.activeId && races[raw.activeId]) ? raw.activeId : null;
    console.log(`📋 ${Object.keys(races).length} Rennen von Disk geladen (${file === LEGACY_FILE ? 'Altformat' : 'races.json'})`);
  } catch (e) { console.error('❌ Rennen laden:', e.message); }
}

// Nur ohne Datenbank - sonst waeren zwei Quellen der Wahrheit im Spiel.
function saveRacesToDisk() {
  if (db.enabled) return;
  try {
    fs.writeFileSync(RACES_FILE,
      JSON.stringify({ events, races, activeId: activeRaceId }, null, 2));
  } catch (e) { console.error('❌ Rennen speichern:', e.message); }
}

// =======================
// GRUPPEN (Renndaten)
// =======================
// groups spiegelt immer den Stand des AKTIVEN Rennens. Der Aufsatzpunkt
// fuer die Taktik-Endpoints bleibt damit unveraendert, die Ablage
// wandert aber ins jeweilige Rennen.
let groups = [];

function syncGroupsToRace() {
  if (activeRaceId && races[activeRaceId]) races[activeRaceId].groups = groups;
}

function syncGroupsFromRace() {
  groups = (activeRaceId && races[activeRaceId] && Array.isArray(races[activeRaceId].groups))
    ? races[activeRaceId].groups
    : [];
}

loadRacesFromDisk();
syncGroupsFromRace();

// =======================
// PERSISTENZ (Neon)
// =======================
// Die Disk bleibt als Cache innerhalb einer Instanz erhalten, die
// Datenbank ist die Quelle der Wahrheit ueber Neustarts hinweg.
// Fehler werden geloggt, aber nie an den Request durchgereicht:
// ein DB-Ausfall waehrend des Rennens darf die Taktik nicht blockieren.
function dbFail(what) {
  return e => console.error(`❌ DB ${what}:`, e.message);
}

function persistEvent(id) {
  if (!db.enabled) return;
  const ev = events[id];
  if (!ev) return;
  db.upsertEvent(ev).catch(dbFail('upsertEvent'));
}

function persistRace(id) {
  if (!db.enabled) return;
  const r = races[id];
  if (!r) return;
  db.upsertRace({
    id:        r.id,
    eventId:   r.eventId,
    name:      r.name,
    category:  r.category,
    startTime: r.startTime,
    createdAt: r.createdAt,
    status:    r.status,
    riders:    r.riders
  }).catch(dbFail('upsertRace'));
}

function persistGroups() {
  if (!db.enabled || !activeRaceId) return;
  db.updateRaceGroups(activeRaceId, groups).catch(dbFail('updateRaceGroups'));
  db.addGapSnapshot(activeRaceId, groups).catch(dbFail('addGapSnapshot'));
}

// GPX gehoert zum Rennen. Eigener Schreibpfad, weil upsertRace die
// Spalte gpx_json bewusst nicht anfasst - so ueberlebt die Strecke
// jedes Stammdaten-Update des Rennens.
function persistGpx(raceId) {
  if (!db.enabled) return;
  const r = races[raceId];
  if (!r) return;
  db.updateRaceGpx(raceId, r.gpx).catch(dbFail('updateRaceGpx'));
}

async function loadStateFromDb() {
  if (!db.enabled) return;

  // Bewusst ganz oben: der Migrations-Zweig weiter unten springt
  // vorzeitig zurueck, die Einstellungen waeren sonst verloren.
  const ds = await db.getSetting('displaySettings');
  if (ds && typeof ds === 'object') displaySettings = sanitizeSettings(ds);

  const rows = await db.listRaces();

  // Einmalige Uebernahme der Disk-Rennen beim ersten Start mit DB
  if (rows.length === 0 && Object.keys(races).length > 0) {
    ensureFallbackEvent();
    await db.upsertEvent(events[FALLBACK_EVENT]);
    for (const r of Object.values(races)) {
      r.eventId = r.eventId || FALLBACK_EVENT;
      await db.upsertRace({
        id: r.id, eventId: r.eventId, name: r.name,
        category: r.category, startTime: r.startTime,
        createdAt: r.createdAt, status: r.status, riders: r.riders
      });
      if (r.groups.length > 0) await db.updateRaceGroups(r.id, r.groups);
      if (r.gpx)               await db.updateRaceGpx(r.id, r.gpx);
    }
    if (activeRaceId) await db.setSetting('activeRaceId', activeRaceId);
    console.log(`📤 ${Object.keys(races).length} Rennen in die Datenbank übernommen`);
    return;
  }

  const evRows = await db.listEvents();
  events = Object.create(null);
  for (const e of evRows) {
    events[e.id] = {
      id:        e.id,
      name:      e.name,
      ort:       e.ort || null,
      dateFrom:  e.date_from ? new Date(e.date_from).toISOString().slice(0, 10) : null,
      dateTo:    e.date_to   ? new Date(e.date_to).toISOString().slice(0, 10)   : null,
      createdAt: e.created_at ? new Date(e.created_at).toISOString() : new Date().toISOString()
    };
  }

  races = Object.create(null);
  for (const r of rows) {
    races[r.id] = {
      id:        r.id,
      eventId:   r.event_id || FALLBACK_EVENT,
      name:      r.name,
      category:  r.category || null,
      startTime: r.start_time ? new Date(r.start_time).toISOString() : null,
      status:    r.status || 'geplant',
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      riders:    Array.isArray(r.riders_json) ? r.riders_json : [],
      groups:    Array.isArray(r.groups_json) ? r.groups_json : [],
      gpx:       (r.gpx_json && Array.isArray(r.gpx_json.coords) && r.gpx_json.coords.length)
                   ? r.gpx_json : null
    };
  }
  if (Object.values(races).some(r => r.eventId === FALLBACK_EVENT)) ensureFallbackEvent();

  const activeId = await db.getSetting('activeRaceId');
  activeRaceId = (activeId && races[activeId]) ? activeId : null;
  syncGroupsFromRace();

  // Das frueher globale GPX wird nicht uebernommen, sondern einmalig
  // entsorgt - Strecken werden pro Rennen neu hochgeladen.
  const oldGpx = await db.getSetting('gpx');
  if (oldGpx) {
    await db.setSetting('gpx', null);
    console.log('🧹 Altes globales GPX verworfen');
  }

  const withGpx = Object.values(races).filter(r => r.gpx).length;
  console.log(`💾 ${evRows.length} Veranstaltung(en), ${rows.length} Rennen geladen, aktiv: ${activeRaceId || 'keins'}, ${groups.length} Gruppe(n), ${withGpx} mit Strecke`);
}

// =======================
// AUTH
// Login-Level:
//   'spolei'   → Vollzugriff (SpoLei / Admin)
//   'betreuer' → Basis-Zugriff (nur eigenen Standort teilen)
// =======================
const ADMIN_PASSWORD    = process.env.ADMIN_PASSWORD    || 'admin123';
const BETREUER_PASSWORD = process.env.BETREUER_PASSWORD || 'betreuer123';

// Map<token, { level: 'spolei' | 'betreuer' }>
const tokens = new Map();

// Jeder eingeloggte Nutzer
function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);
  const entry = tokens.get(token);
  if (!entry) return res.status(401).json({ error: 'Invalid token' });
  req.userLevel = entry.level;
  next();
}

// Nur SpoLei
function requireSpolei(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);
  const entry = tokens.get(token);
  if (!entry || entry.level !== 'spolei') {
    return res.status(403).json({ error: 'Forbidden: SpoLei access required' });
  }
  req.userLevel = 'spolei';
  next();
}

// =======================
// HEALTH CHECK
// =======================
app.get('/health', (req, res) => {
  res.send('🚀 Tracking Server läuft');
});

// =======================
// AUTH ENDPOINTS
// =======================
app.post('/login', (req, res) => {
  const { password } = req.body;
  let level = null;
  if (password === ADMIN_PASSWORD)    level = 'spolei';
  if (password === BETREUER_PASSWORD) level = 'betreuer';
  if (!level) return res.status(401).json({ error: 'Wrong password' });
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  tokens.set(token, { level });
  console.log(`🔓 Login: ${level}`);
  res.json({ token, level });
});

app.post('/logout', requireAuth, (req, res) => {
  const token = req.headers['authorization'].slice(7);
  tokens.delete(token);
  console.log(`🚪 Logout: ${req.userLevel}`);
  res.json({ ok: true });
});

// =======================
// POSITIONEN (GPS-Tracker schreiben via MQTT, POST bleibt für Kompatibilität)
// =======================
app.post('/positions', (req, res) => {
  const { id, lat, lon } = req.body;
  if (!id || typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ error: 'id, lat, lon required' });
  }
  positions[id] = { lat, lon, timestamp: Date.now() };
  res.json({ ok: true });
});

app.get('/positions', (req, res) => {
  const enriched = Object.create(null);
  for (const [id, pos] of Object.entries(positions)) {
    if (pos.type === 'betreuer') {
      enriched[id] = { ...pos };
    } else {
      enriched[id] = { ...pos, displayName: trackerDisplayNames[id] || id };
    }
  }
  res.json(enriched);
});

// Tracker ohne Fix. Bewusst ein eigener Endpoint statt eines
// zusaetzlichen Schluessels in /positions: das Frontend iteriert
// dort mit Object.keys() ueber ALLE Eintraege, ein Sonderschluessel
// "pending" waere dort als Tracker interpretiert worden.
app.get('/pending', (req, res) => {
  const now = Date.now();
  const out = [];
  for (const [id, p] of Object.entries(pending)) {
    // Laenger als PENDING_TIMEOUT_MS nichts gehoert -> wirklich weg
    if (now - p.timestamp > PENDING_TIMEOUT_MS) { delete pending[id]; continue; }
    // Letzte echte Position ist neuer als die letzte Suchmeldung
    // -> Tracker hat inzwischen Fix
    const pos = positions[id];
    if (pos && pos.timestamp >= p.timestamp) { delete pending[id]; continue; }
    out.push({
      id,
      displayName: trackerDisplayNames[id] || id,
      sats:        p.sats,
      since:       p.since,
      timestamp:   p.timestamp
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  res.json({ pending: out });
});

app.delete('/positions', requireSpolei, (req, res) => {
  for (const key of Object.keys(positions)) delete positions[key];
  for (const key of Object.keys(pending))   delete pending[key];
  console.log("🧹 Positionen gelöscht");
  res.json({ ok: true });
});

// =======================
// BETREUER-POSITION (NEU)
// Jeder eingeloggte Nutzer kann seinen Standort einmalig als Betreuer-Marker setzen.
// =======================
app.post('/betreuer-position', requireAuth, (req, res) => {
  const { lat, lon, name } = req.body;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !name) {
    return res.status(400).json({ error: 'lat, lon, name required' });
  }
  const safeName = String(name).trim().slice(0, 40);
  const id = 'betreuer-' + safeName
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 30);
  positions[id] = { lat, lon, timestamp: Date.now(), type: 'betreuer', name: safeName };
  console.log(`👤 Betreuer gesetzt: "${safeName}" → ${id}`);
  res.json({ ok: true, id });
});

// =======================
// TEAM-POSITION (SpoLei only)
// =======================
app.post('/team-position', requireSpolei, (req, res) => {
  const { lat, lon } = req.body;
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ error: 'lat, lon required' });
  }
  positions['TEAMAUTO'] = { lat, lon, timestamp: Date.now() };
  res.json({ ok: true });
});

// =======================
// RENAME TRACKER (SpoLei only)
// Speichert Anzeigenamen – Hardware-ID bleibt erhalten
// =======================
app.post('/rename-tracker', requireSpolei, (req, res) => {
  const { trackerId, newName } = req.body;
  if (!trackerId || !newName) return res.status(400).json({ error: 'trackerId, newName required' });
  trackerDisplayNames[trackerId] = newName.trim();
  console.log(`✏️ Tracker umbenannt: ${trackerId} → ${newName}`);
  res.json({ ok: true });
});

// =======================
// CLAUDE API PROXY
// API-Key bleibt server-seitig, Browser-CORS-Problem umgangen
// =======================
app.post('/api/claude', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY nicht konfiguriert' });
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Claude Proxy Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================
// GPX TRACK
// =======================
// Die Strecke gehoert zum Rennen. Geschrieben wird ueber
// /races/:id/gpx - dafuer muss das Rennen NICHT aktiv sein, damit sich
// ein ganzes Wochenende vorbereiten laesst. Gelesen wird ueber /gpx,
// das immer die Strecke des aktiven Rennens liefert.

app.get('/gpx', (req, res) => {
  const r = activeRaceId ? races[activeRaceId] : null;
  res.json((r && r.gpx) || null);
});

app.put('/races/:id/gpx', requireSpolei, (req, res) => {
  const r = races[req.params.id];
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const { coords, name } = req.body;
  if (!Array.isArray(coords) || coords.length === 0) {
    return res.status(400).json({ error: 'coords[] erforderlich' });
  }
  r.gpx = { coords, name: name || 'GPX Track' };
  saveRacesToDisk();
  persistGpx(r.id);
  console.log(`📂 Strecke gespeichert: "${r.name}" \u2190 ${r.gpx.name} (${coords.length} Punkte)`);
  res.json({ ok: true, pointCount: coords.length });
});

app.delete('/races/:id/gpx', requireSpolei, (req, res) => {
  const r = races[req.params.id];
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  r.gpx = null;
  saveRacesToDisk();
  persistGpx(r.id);
  console.log(`🗑️ Strecke gelöscht: "${r.name}"`);
  res.json({ ok: true });
});

// =======================
// MODUS (race / training)
// =======================
app.get('/mode', (req, res) => {
  res.json({ mode: currentMode });
});

app.post('/mode', requireSpolei, (req, res) => {
  const { mode } = req.body;
  if (mode !== 'race' && mode !== 'training') {
    return res.status(400).json({ error: 'mode must be race or training' });
  }
  currentMode = mode;
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish('livetracking-fq4l/config', mode, { retain: true, qos: 0 });
  }
  console.log(`🔄 Modus: ${mode}`);
  res.json({ ok: true, mode: currentMode });
});

// =======================
// VERANSTALTUNGEN & RENNEN - ENDPOINTS
// =======================
function raceView(r) {
  return {
    id:         r.id,
    eventId:    r.eventId,
    name:       r.name,
    category:   r.category,
    startTime:  r.startTime,
    status:     r.status,
    createdAt:  r.createdAt,
    riderCount: r.riders.length,
    // Bewusst NUR Kennzeichen statt r.gpx: sonst haengen an jedem
    // GET /events saemtliche Streckenpunkte aller Rennen.
    hasGpx:     !!r.gpx,
    gpxName:    r.gpx ? r.gpx.name : null,
    isActive:   r.id === activeRaceId
  };
}

function racesOfEvent(eventId) {
  return Object.values(races)
    .filter(r => r.eventId === eventId)
    .sort((a, b) => (a.startTime || a.createdAt).localeCompare(b.startTime || b.createdAt))
    .map(raceView);
}

// Genau ein Rennen ist aktiv. Der Wechsel zieht den Taktik-Stand mit:
// die Gruppen des alten Rennens bleiben dort gespeichert.
function activateRace(id) {
  if (activeRaceId && races[activeRaceId] && activeRaceId !== id) {
    races[activeRaceId].groups = groups;
    races[activeRaceId].status = 'beendet';
    persistRace(activeRaceId);
  }
  activeRaceId = id;
  races[id].status = 'aktiv';
  syncGroupsFromRace();
  saveRacesToDisk();
  // Verkettet, nicht parallel: clearActiveStatus wuerde sonst je nach
  // Pool-Reihenfolge den frisch gesetzten Status wieder auf 'beendet'
  // zuruecksetzen.
  if (db.enabled) {
    db.clearActiveStatus()
      .then(() => db.upsertRace({
        id:        races[id].id,
        eventId:   races[id].eventId,
        name:      races[id].name,
        category:  races[id].category,
        startTime: races[id].startTime,
        createdAt: races[id].createdAt,
        status:    'aktiv',
        riders:    races[id].riders
      }))
      .then(() => db.setSetting('activeRaceId', id))
      .catch(dbFail('activateRace'));
  }
  pushAutoDisplays();
}

// --- Veranstaltungen ---
app.get('/events', (req, res) => {
  const list = Object.values(events)
    .sort((a, b) => (b.dateFrom || b.createdAt).localeCompare(a.dateFrom || a.createdAt))
    .map(ev => ({ ...ev, races: racesOfEvent(ev.id) }));
  res.json({ events: list, activeRaceId });
});

app.post('/events', requireSpolei, (req, res) => {
  const { name, ort, dateFrom, dateTo } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name erforderlich' });
  const id = newId();
  events[id] = {
    id,
    name:      String(name).trim(),
    ort:       ort ? String(ort).trim() : null,
    dateFrom:  dateFrom || null,
    dateTo:    dateTo   || null,
    createdAt: new Date().toISOString()
  };
  saveRacesToDisk();
  persistEvent(id);
  console.log(`🏁 Veranstaltung angelegt: "${events[id].name}"`);
  res.json({ ok: true, id, event: events[id] });
});

app.patch('/events/:id', requireSpolei, (req, res) => {
  const ev = events[req.params.id];
  if (!ev) return res.status(404).json({ error: 'Nicht gefunden' });
  const { name, ort, dateFrom, dateTo } = req.body;
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'name darf nicht leer sein' });
    ev.name = String(name).trim();
  }
  if (ort      !== undefined) ev.ort      = ort ? String(ort).trim() : null;
  if (dateFrom !== undefined) ev.dateFrom = dateFrom || null;
  if (dateTo   !== undefined) ev.dateTo   = dateTo   || null;
  saveRacesToDisk();
  persistEvent(ev.id);
  res.json({ ok: true, event: ev });
});

// Loeschen nimmt alle Rennen der Veranstaltung mit (DB: ON DELETE CASCADE,
// inkl. Abstandsverlauf). Das aktive Rennen blockiert das bewusst.
app.delete('/events/:id', requireSpolei, (req, res) => {
  const { id } = req.params;
  if (!events[id]) return res.status(404).json({ error: 'Nicht gefunden' });
  const own = Object.values(races).filter(r => r.eventId === id);
  if (own.some(r => r.id === activeRaceId)) {
    return res.status(409).json({ error: 'Aktives Rennen liegt in dieser Veranstaltung' });
  }
  const name = events[id].name;
  for (const r of own) delete races[r.id];
  delete events[id];
  saveRacesToDisk();
  if (db.enabled) db.deleteEvent(id).catch(dbFail('deleteEvent'));
  console.log(`🗑️ Veranstaltung gelöscht: "${name}" (${own.length} Rennen)`);
  res.json({ ok: true, deletedRaces: own.length });
});

// --- Rennen ---
app.get('/races', (req, res) => {
  const list = Object.values(races).map(raceView);
  res.json({ races: list, activeId: activeRaceId });
});

app.get('/races/active', (req, res) => {
  if (!activeRaceId || !races[activeRaceId]) return res.json([]);
  res.json(races[activeRaceId].riders);
});

app.post('/races', requireSpolei, (req, res) => {
  const { eventId, name, category, startTime, riders } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name erforderlich' });
  const evId = eventId && events[eventId] ? eventId : ensureFallbackEvent().id;
  const id   = newId();
  races[id] = normalizeRace({
    id,
    eventId:   evId,
    name:      String(name).trim(),
    category:  category ? String(category).trim() : null,
    startTime: startTime || null,
    createdAt: new Date().toISOString(),
    riders:    Array.isArray(riders) ? riders : []
  });
  saveRacesToDisk();
  persistRace(id);
  console.log(`🚴 Rennen angelegt: "${races[id].name}" (${races[id].riders.length} Fahrer)`);
  res.json({ ok: true, id, race: raceView(races[id]) });
});

app.patch('/races/:id', requireSpolei, (req, res) => {
  const r = races[req.params.id];
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const { eventId, name, category, startTime } = req.body;
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'name darf nicht leer sein' });
    r.name = String(name).trim();
  }
  if (category  !== undefined) r.category  = category ? String(category).trim() : null;
  if (startTime !== undefined) r.startTime = startTime || null;
  if (eventId   !== undefined && events[eventId]) r.eventId = eventId;
  saveRacesToDisk();
  persistRace(r.id);
  res.json({ ok: true, race: raceView(r) });
});

// Startliste setzen bzw. ersetzen - Ziel des Imports.
app.put('/races/:id/riders', requireSpolei, (req, res) => {
  const r = races[req.params.id];
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const { riders } = req.body;
  if (!Array.isArray(riders)) return res.status(400).json({ error: 'riders[] erforderlich' });
  // Favoriten ueber den Re-Import retten: eine korrigierte Startliste
  // soll die Sternchen nicht mitnehmen.
  const prevFav = new Set(
    r.riders.filter(x => x && x.fav).map(x => Number(x.nr))
  );
  r.riders = riders.map(x =>
    prevFav.has(Number(x && x.nr)) ? { ...x, fav: true } : x
  );
  saveRacesToDisk();
  if (db.enabled) db.updateRaceRiders(r.id, r.riders).catch(dbFail('updateRaceRiders'));
  if (r.id === activeRaceId) pushAutoDisplays();
  console.log(`📋 Startliste gesetzt: "${r.name}" (${r.riders.length} Fahrer)`);
  res.json({ ok: true, riderCount: r.riders.length });
});

// Einzelnen Fahrer als Favorit markieren bzw. die Markierung loesen.
// Bewusst pro Fahrer statt als komplette Liste: die Taktikansicht kennt
// nur die Fahrer in den Gruppen, ein PUT der ganzen Liste wuerde die
// Sternchen aller uebrigen Fahrer loeschen.
app.post('/races/:id/favorite', requireSpolei, (req, res) => {
  const r = races[req.params.id];
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const nr  = Number(req.body.nr);
  const fav = !!req.body.fav;
  if (isNaN(nr)) return res.status(400).json({ error: 'nr erforderlich' });
  const rider = r.riders.find(x => x && Number(x.nr) === nr);
  if (!rider) return res.status(404).json({ error: 'Fahrer nicht in der Startliste' });
  if (fav) rider.fav = true;
  else     delete rider.fav;
  saveRacesToDisk();
  if (db.enabled) db.updateRaceRiders(r.id, r.riders).catch(dbFail('updateRaceRiders fav'));
  if (r.id === activeRaceId) pushAutoDisplays();
  console.log(`\u2B50 Favorit ${fav ? 'gesetzt' : 'entfernt'}: Nr. ${nr} in "${r.name}"`);
  res.json({ ok: true, nr, fav });
});

app.post('/races/:id/activate', requireSpolei, (req, res) => {
  const { id } = req.params;
  if (!races[id]) return res.status(404).json({ error: 'Nicht gefunden' });
  activateRace(id);
  console.log(`✅ Aktives Rennen: "${races[id].name}"`);
  res.json({ ok: true, activeId: activeRaceId });
});

app.delete('/races/:id', requireSpolei, (req, res) => {
  const { id } = req.params;
  if (!races[id]) return res.status(404).json({ error: 'Nicht gefunden' });
  const name = races[id].name;
  delete races[id];
  if (activeRaceId === id) {
    activeRaceId = null;
    groups = [];
    if (db.enabled) db.setSetting('activeRaceId', null).catch(dbFail('setSetting activeRaceId'));
  }
  saveRacesToDisk();
  if (db.enabled) db.deleteRace(id).catch(dbFail('deleteRace'));
  console.log(`🗑️ Rennen gelöscht: "${name}"`);
  res.json({ ok: true });
});

// =======================
// STARTLISTEN ENDPOINTS (veraltet)
// =======================
// Halten das bestehende Frontend am Leben, bis Stufe 2.2 auf /races
// umgestellt ist. Entfernen in Stufe 2.3.
app.get('/startlists', (req, res) => {
  const list = Object.values(races).map(r => ({
    id:         r.id,
    name:       r.name,
    createdAt:  r.createdAt,
    riderCount: r.riders.length,
    isActive:   r.id === activeRaceId
  }));
  res.json({ lists: list, activeId: activeRaceId });
});

app.get('/startlists/active', (req, res) => {
  if (!activeRaceId || !races[activeRaceId]) return res.json([]);
  res.json(races[activeRaceId].riders);
});

app.post('/startlists', requireSpolei, (req, res) => {
  const { name, riders } = req.body;
  if (!name || !Array.isArray(riders) || riders.length === 0) {
    return res.status(400).json({ error: 'name und riders[] erforderlich' });
  }
  const id = newId();
  races[id] = normalizeRace({
    id,
    eventId:   ensureFallbackEvent().id,
    name:      String(name).trim(),
    createdAt: new Date().toISOString(),
    riders
  });
  saveRacesToDisk();
  persistRace(id);
  console.log(`📋 Startliste gespeichert: "${name}" (${riders.length} Fahrer)`);
  res.json({ ok: true, id });
});

app.delete('/startlists/:id', requireSpolei, (req, res) => {
  const { id } = req.params;
  if (!races[id]) return res.status(404).json({ error: 'Nicht gefunden' });
  const name = races[id].name;
  delete races[id];
  if (activeRaceId === id) {
    activeRaceId = null;
    groups = [];
    if (db.enabled) db.setSetting('activeRaceId', null).catch(dbFail('setSetting activeRaceId'));
  }
  saveRacesToDisk();
  if (db.enabled) db.deleteRace(id).catch(dbFail('deleteRace'));
  console.log(`🗑️ Startliste gelöscht: "${name}"`);
  res.json({ ok: true });
});

app.post('/startlists/:id/activate', requireSpolei, (req, res) => {
  const { id } = req.params;
  if (!races[id]) return res.status(404).json({ error: 'Nicht gefunden' });
  activateRace(id);
  console.log(`✅ Aktive Startliste: "${races[id].name}"`);
  res.json({ ok: true });
});

// =======================
// DISPLAY-NACHRICHTEN
// =======================
app.get('/displays', (req, res) => {
  res.json({
    texts:    displayTexts,
    auto:     autoDisplay,
    preview:  buildAutoText(),
    settings: displaySettings,
    maxLen:   DISPLAY_MAX
  });
});

// Einstellungen fuer den Automatik-Text. Angehaengt an /displays
// gelesen, damit die Taktikansicht mit einem Request auskommt.
app.post('/display-settings', requireSpolei, (req, res) => {
  displaySettings = sanitizeSettings(req.body);
  if (db.enabled) db.setSetting('displaySettings', displaySettings).catch(dbFail('setSetting displaySettings'));
  pushAutoDisplays();
  console.log(`\u2699\uFE0F Anzeige-Einstellungen: ${JSON.stringify(displaySettings)}`);
  res.json({ ok: true, settings: displaySettings, preview: buildAutoText() });
});

// Automatik pro Tracker ein-/ausschalten
app.post('/display-auto', requireSpolei, (req, res) => {
  const { id, auto } = req.body;
  if (!id) return res.status(400).json({ error: 'id erforderlich' });
  if (auto) autoDisplay[id] = true;
  else      delete autoDisplay[id];
  console.log(`\u{1F916} Auto ${id}: ${auto ? 'an' : 'aus'}`);
  if (auto) pushAutoDisplays();
  res.json({ ok: true, auto: !!auto });
});

app.post('/display', requireSpolei, (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id erforderlich' });

  const text = sanitizeDisplay(req.body.text);
  if (!mqttClient || !mqttClient.connected) {
    return res.status(503).json({ error: 'MQTT nicht verbunden' });
  }
  // Manuelles Senden hebt die Automatik fuer diesen Tracker auf
  delete autoDisplay[id];

  // Leerer Text loescht die retained Message beim Broker.
  mqttClient.publish(`livetracking-fq4l/display/${id}`, text, { retain: true, qos: 0 });
  if (text.length > 0) displayTexts[id] = text;
  else                 delete displayTexts[id];

  console.log(`\u{1F4DF} Display ${id} \u2192 "${text}"`);
  res.json({ ok: true, text });
});

// =======================
// GRUPPEN ENDPOINTS
// =======================
app.get('/groups', (req, res) => {
  const riderMap = Object.create(null);
  if (activeRaceId && races[activeRaceId]) {
    for (const r of races[activeRaceId].riders) {
      riderMap[Number(r.nr)] = { name: r.name, team: r.team, fav: !!r.fav };
    }
  }
  const enriched = groups.map(g => ({
    ...g,
    riders: (g.riders || []).map(nr => ({ nr, ...(riderMap[Number(nr)] || {}) }))
  }));
  res.json(enriched);
});

app.post('/groups', requireSpolei, (req, res) => {
  const { groups: g } = req.body;
  if (!Array.isArray(g)) return res.status(400).json({ error: 'groups[] erforderlich' });
  // Genau eine Gruppe darf das Hauptfeld sein. Ohne das koennte ein
  // Browser-Tab mit altem Stand einen zweiten Marker setzen - der Text
  // waere dann mitten im Rennen an der falschen Stelle zu Ende.
  let seenMain = false;
  for (const grp of g) {
    if (!grp || grp.main !== true) continue;
    if (seenMain) delete grp.main;
    else          seenMain = true;
  }
  groups = g;
  syncGroupsToRace();          // Stand haengt am Rennen, nicht am Server
  saveRacesToDisk();
  pushAutoDisplays();          // Automatik-Tracker sofort nachziehen
  persistGroups();             // Stand + Abstandsverlauf sichern
  res.json({ ok: true });
});

app.delete('/groups', requireSpolei, (req, res) => {
  groups = [];
  syncGroupsToRace();
  saveRacesToDisk();
  pushAutoDisplays();
  persistGroups();
  console.log('🧹 Gruppen gelöscht');
  res.json({ ok: true });
});

// =======================
// MQTT BRIDGE
// =======================
const MQTT_BROKER   = 'mqtt://broker.emqx.io:1883';
const MQTT_TOPIC    = 'livetracking-fq4l/positions';
const MQTT_DISPLAYS = 'livetracking-fq4l/display/+';

let mqttClient = null;

function connectMqtt() {
  mqttClient = mqtt.connect(MQTT_BROKER, {
    clientId:        'render-server-' + Math.random().toString(36).slice(2),
    clean:           true,
    reconnectPeriod: 5000,
    connectTimeout:  15000
  });

  mqttClient.on('connect', () => {
    console.log('✅ MQTT verbunden mit broker.emqx.io');
    mqttClient.subscribe(MQTT_TOPIC, err => {
      if (err) console.error('❌ MQTT Subscribe Fehler:', err.message);
      else     console.log(`📡 MQTT subscribed: ${MQTT_TOPIC}`);
    });
    // Eigene Display-Topics mitlesen: der Broker liefert die retained
    // Messages sofort, damit kennen wir nach jedem Neustart wieder den
    // aktuellen Stand jedes Garmin-Displays.
    mqttClient.subscribe(MQTT_DISPLAYS, err => {
      if (err) console.error('❌ MQTT Subscribe Fehler:', err.message);
      else     console.log(`📡 MQTT subscribed: ${MQTT_DISPLAYS}`);
    });
    // Retained config-Nachricht beim (Re-)Connect wiederherstellen
    mqttClient.publish('livetracking-fq4l/config', currentMode, { retain: true, qos: 0 });
  });

  mqttClient.on('message', (topic, message) => {
    // Display-Topics zuerst: die tragen reinen Text, kein JSON
    if (topic.startsWith('livetracking-fq4l/display/')) {
      const id   = topic.slice('livetracking-fq4l/display/'.length);
      const text = message.toString();
      if (text.length > 0) displayTexts[id] = text;
      else                 delete displayTexts[id];
      return;
    }
    try {
      const data = JSON.parse(message.toString());
      const { id, lat, lon, bat, mode } = data;
      if (!id) return;

      // Status-Heartbeat ohne Koordinaten: Tracker ist online, sucht
      // aber noch GPS. Kommt NICHT nach positions{} - ein Eintrag ohne
      // lat/lon wuerde die Kartenlogik im Frontend zerlegen.
      if (typeof lat !== 'number' || typeof lon !== 'number') {
        if (data.fix === 0) {
          const prev = pending[id];
          pending[id] = {
            // since nur beim ersten Beat setzen: sonst zaehlt die
            // Suchdauer bei jeder Meldung wieder von vorn los
            since:     prev ? prev.since : Date.now(),
            timestamp: Date.now(),
            sats:      typeof data.sats === 'number' ? data.sats : null
          };
          console.log(`🛰️ Sucht GPS: ${id} [${data.sats === undefined ? '?' : data.sats} Sat]`);
        }
        return;
      }

      delete pending[id];   // Fix da -> raus aus der Warteliste
      positions[id] = { lat, lon, timestamp: Date.now() };
      if (typeof bat === 'number') positions[id].bat = bat;
      if (mode === 'training' || mode === 'race') positions[id].trackerMode = mode;
      console.log(`📍 MQTT: ${id} → ${lat}, ${lon}${mode ? ' [' + mode + ']' : ''}`);
    } catch (e) {
      console.error('❌ MQTT Nachricht ungültig:', e.message);
    }
  });

  mqttClient.on('error',      err => console.error('❌ MQTT Fehler:', err.message));
  mqttClient.on('reconnect',  ()  => console.log('🔄 MQTT reconnect…'));
  mqttClient.on('disconnect', ()  => console.log('⚠️ MQTT getrennt'));
}

connectMqtt();

// =======================
// START
// =======================
const PORT = process.env.PORT || 3000;

// Erst den Zustand aus der Datenbank holen, dann Requests annehmen.
// Bewusst in try/catch: ist Neon nicht erreichbar, startet der Server
// trotzdem - mit leerem Stand, aber er startet.
(async () => {
  try {
    await db.init();
    await loadStateFromDb();
  } catch (e) {
    console.error('❌ DB-Start fehlgeschlagen, laufe ohne Persistenz:', e.message);
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server läuft auf Port ${PORT}`);
  });
})();
