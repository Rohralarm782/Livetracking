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
let gpxTrack  = null;
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
// Nur druckbares ASCII: Umlaute oder Emoji wuerden auf dem
// Garmin als leere Kaestchen erscheinen.
function sanitizeDisplay(text) {
  let out = '';
  const src = String(text == null ? '' : text);
  for (let i = 0; i < src.length && out.length < 60; i++) {
    const c = src.charCodeAt(i);
    if (c >= 32 && c <= 126) out += src[i];
  }
  return out.trim();
}

// Baut den Anzeigetext aus dem aktuellen Gruppenstand.
// Format je Gruppe: "<Anzahl>x <Abstand nach hinten>"
// Das 'x' klebt an der Zahl und macht sie als Stueckzahl kenntlich -
// ohne das liest sich "6 0:15" wie zwei gleichrangige Zahlen.
// Muss ASCII bleiben: bytesToLines() im Datenfeld filtert auf 32-126,
// ein typografisches Mal-Zeichen wuerde stillschweigend verschluckt.
// gefolgt von "~<Startnummern>" (optional, darf wegfallen).
// Die letzte Gruppe ist das Feld und bekommt "...".
//
// Der Abstand steht in groups[i].gap und meint den Rueckstand
// AUF DIE GRUPPE DAVOR. Fuer "Abstand nach hinten" brauchen
// wir daher den gap der FOLGENDEN Gruppe.
function buildAutoText() {
  if (!Array.isArray(groups) || groups.length === 0) return '';
  const parts = [];
  for (let i = 0; i < groups.length; i++) {
    const g     = groups[i];
    const riders = Array.isArray(g.riders) ? g.riders : [];
    const isLast = (i === groups.length - 1);

    // Letzte Gruppe ohne Fahrer = das Feld
    if (isLast && riders.length === 0) { parts.push('...'); break; }

    const next = groups[i + 1];
    const gap  = next && next.gap ? String(next.gap).trim() : '';
    let seg = String(riders.length) + 'x';
    if (gap.length > 0) seg += ' ' + gap;
    parts.push(seg);

    // Startnummern als optionaler Teil, maximal drei.
    // Komma statt Leerzeichen: in der kleinen Schrift der optionalen
    // Zeile ist ein Leerzeichen zu schmal, "8 9" liest sich sonst als
    // "89". Kostet kein zusaetzliches Zeichen.
    const nrs = riders
      .map(r => (r && r.nr !== undefined) ? r.nr : r)
      .filter(n => n !== undefined && n !== null)
      .slice(0, 3);
    if (nrs.length > 0) parts.push('~' + nrs.join(','));
  }
  // '~' leitet seinen Abschnitt selbst ein, davor kein ';'
  let out = '';
  for (const p of parts) {
    if (out.length === 0)        out = p;
    else if (p.startsWith('~'))  out += p;
    else                         out += ';' + p;
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
// STARTLISTEN (persistent auf Disk)
// =======================
const STARTLISTS_FILE = path.join(__dirname, 'startlists.json');
let startlists        = Object.create(null);
let activeStartlistId = null;

function loadStartlistsFromDisk() {
  try {
    if (fs.existsSync(STARTLISTS_FILE)) {
      const raw      = JSON.parse(fs.readFileSync(STARTLISTS_FILE, 'utf8'));
      startlists      = raw.lists   || Object.create(null);
      activeStartlistId = raw.activeId || null;
      console.log(`📋 ${Object.keys(startlists).length} Startliste(n) geladen`);
    }
  } catch (e) { console.error('❌ Startlisten laden:', e.message); }
}

function saveStartlistsToDisk() {
  try {
    fs.writeFileSync(STARTLISTS_FILE,
      JSON.stringify({ lists: startlists, activeId: activeStartlistId }, null, 2));
  } catch (e) { console.error('❌ Startlisten speichern:', e.message); }
}

loadStartlistsFromDisk();

// =======================
// GRUPPEN (Renndaten)
// =======================
let groups = [];

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

// Ein Startlisten-Eintrag IST bereits ein Rennen - nur ohne Veranstaltung.
// Deshalb wird er 1:1 in races geschrieben; die Veranstaltungs-Ebene
// kommt in Stufe 2 obendrauf, ohne dass Daten migriert werden muessen.
function persistRace(id) {
  if (!db.enabled) return;
  const sl = startlists[id];
  if (!sl) return;
  db.upsertRace({
    id:        sl.id,
    eventId:   sl.eventId || null,
    name:      sl.name,
    createdAt: sl.createdAt,
    status:    id === activeStartlistId ? 'aktiv' : 'geplant',
    riders:    sl.riders
  }).catch(dbFail('upsertRace'));
}

function persistGroups() {
  if (!db.enabled || !activeStartlistId) return;
  db.updateRaceGroups(activeStartlistId, groups).catch(dbFail('updateRaceGroups'));
  db.addGapSnapshot(activeStartlistId, groups).catch(dbFail('addGapSnapshot'));
}

// GPX haengt aktuell global am Server, nicht am Rennen. Bis die
// Rennen-UI steht, wird er deshalb in settings abgelegt - sonst
// haette er ohne aktives Rennen keinen Platz.
function persistGpx() {
  if (!db.enabled) return;
  db.setSetting('gpx', gpxTrack).catch(dbFail('setSetting gpx'));
}

async function loadStateFromDb() {
  if (!db.enabled) return;
  const rows = await db.listRaces();

  // Einmalige Uebernahme der Disk-Startlisten beim ersten Start mit DB
  if (rows.length === 0 && Object.keys(startlists).length > 0) {
    const evId = 'archiv';
    await db.upsertEvent({ id: evId, name: 'Archiv', notes: 'Automatisch übernommene Startlisten' });
    for (const sl of Object.values(startlists)) {
      sl.eventId = evId;
      await db.upsertRace({
        id: sl.id, eventId: evId, name: sl.name,
        createdAt: sl.createdAt, status: 'geplant', riders: sl.riders
      });
    }
    if (activeStartlistId) await db.setSetting('activeRaceId', activeStartlistId);
    console.log(`📤 ${Object.keys(startlists).length} Startliste(n) in die Datenbank übernommen`);
    return;
  }

  startlists = Object.create(null);
  for (const r of rows) {
    startlists[r.id] = {
      id:        r.id,
      eventId:   r.event_id,
      name:      r.name,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      riders:    Array.isArray(r.riders_json) ? r.riders_json : []
    };
  }

  const activeId = await db.getSetting('activeRaceId');
  activeStartlistId = (activeId && startlists[activeId]) ? activeId : null;

  if (activeStartlistId) {
    const row = rows.find(r => r.id === activeStartlistId);
    groups = (row && Array.isArray(row.groups_json)) ? row.groups_json : [];
  }

  const gpx = await db.getSetting('gpx');
  if (gpx && Array.isArray(gpx.coords) && gpx.coords.length > 0) gpxTrack = gpx;

  console.log(`💾 ${rows.length} Rennen geladen, aktiv: ${activeStartlistId || 'keins'}, ${groups.length} Gruppe(n)`);
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
app.get('/gpx', (req, res) => {
  res.json(gpxTrack || null);
});

app.post('/gpx', requireSpolei, (req, res) => {
  const { coords, name } = req.body;
  if (!Array.isArray(coords) || coords.length === 0) {
    return res.status(400).json({ error: 'coords array required' });
  }
  gpxTrack = { coords, name: name || 'GPX Track' };
  persistGpx();
  console.log(`📂 GPX gespeichert: ${name} (${coords.length} Punkte)`);
  res.json({ ok: true });
});

app.delete('/gpx', requireSpolei, (req, res) => {
  gpxTrack = null;
  persistGpx();
  console.log("🗑️ GPX gelöscht");
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
// STARTLISTEN ENDPOINTS
// =======================
app.get('/startlists', (req, res) => {
  const list = Object.values(startlists).map(sl => ({
    id:         sl.id,
    name:       sl.name,
    createdAt:  sl.createdAt,
    riderCount: sl.riders.length,
    isActive:   sl.id === activeStartlistId
  }));
  res.json({ lists: list, activeId: activeStartlistId });
});

app.get('/startlists/active', (req, res) => {
  if (!activeStartlistId || !startlists[activeStartlistId]) return res.json([]);
  res.json(startlists[activeStartlistId].riders);
});

app.post('/startlists', requireSpolei, (req, res) => {
  const { name, riders } = req.body;
  if (!name || !Array.isArray(riders) || riders.length === 0) {
    return res.status(400).json({ error: 'name und riders[] erforderlich' });
  }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  startlists[id] = { id, name: name.trim(), createdAt: new Date().toISOString(), riders };
  saveStartlistsToDisk();
  persistRace(id);
  console.log(`📋 Startliste gespeichert: "${name}" (${riders.length} Fahrer)`);
  res.json({ ok: true, id });
});

app.delete('/startlists/:id', requireSpolei, (req, res) => {
  const { id } = req.params;
  if (!startlists[id]) return res.status(404).json({ error: 'Nicht gefunden' });
  const name = startlists[id].name;
  delete startlists[id];
  if (activeStartlistId === id) {
    activeStartlistId = null;
    if (db.enabled) db.setSetting('activeRaceId', null).catch(dbFail('setSetting activeRaceId'));
  }
  saveStartlistsToDisk();
  if (db.enabled) db.deleteRace(id).catch(dbFail('deleteRace'));
  console.log(`🗑️ Startliste gelöscht: "${name}"`);
  res.json({ ok: true });
});

app.post('/startlists/:id/activate', requireSpolei, (req, res) => {
  const { id } = req.params;
  if (!startlists[id]) return res.status(404).json({ error: 'Nicht gefunden' });
  activeStartlistId = id;
  saveStartlistsToDisk();
  if (db.enabled) db.setSetting('activeRaceId', id).catch(dbFail('setSetting activeRaceId'));
  console.log(`✅ Aktive Startliste: "${startlists[id].name}"`);
  res.json({ ok: true });
});

// =======================
// DISPLAY-NACHRICHTEN
// =======================
app.get('/displays', (req, res) => {
  res.json({ texts: displayTexts, auto: autoDisplay, preview: buildAutoText() });
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
  if (activeStartlistId && startlists[activeStartlistId]) {
    for (const r of startlists[activeStartlistId].riders) {
      riderMap[Number(r.nr)] = { name: r.name, team: r.team };
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
  groups = g;
  pushAutoDisplays();          // Automatik-Tracker sofort nachziehen
  persistGroups();             // Stand + Abstandsverlauf sichern
  res.json({ ok: true });
});

app.delete('/groups', requireSpolei, (req, res) => {
  groups = [];
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
