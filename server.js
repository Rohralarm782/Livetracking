const express = require('express');
const cors    = require('cors');
const mqtt    = require('mqtt');
const fs      = require('fs');
const path    = require('path');

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

    // Startnummern als optionaler Teil, maximal drei
    const nrs = riders
      .map(r => (r && r.nr !== undefined) ? r.nr : r)
      .filter(n => n !== undefined && n !== null)
      .slice(0, 3);
    if (nrs.length > 0) parts.push('~' + nrs.join(' '));
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
// GRUPPEN (in-memory, Renndaten)
// =======================
let groups = [];

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

app.delete('/positions', requireSpolei, (req, res) => {
  for (const key of Object.keys(positions)) delete positions[key];
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
  console.log(`📂 GPX gespeichert: ${name} (${coords.length} Punkte)`);
  res.json({ ok: true });
});

app.delete('/gpx', requireSpolei, (req, res) => {
  gpxTrack = null;
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
  console.log(`📋 Startliste gespeichert: "${name}" (${riders.length} Fahrer)`);
  res.json({ ok: true, id });
});

app.delete('/startlists/:id', requireSpolei, (req, res) => {
  const { id } = req.params;
  if (!startlists[id]) return res.status(404).json({ error: 'Nicht gefunden' });
  const name = startlists[id].name;
  delete startlists[id];
  if (activeStartlistId === id) activeStartlistId = null;
  saveStartlistsToDisk();
  console.log(`🗑️ Startliste gelöscht: "${name}"`);
  res.json({ ok: true });
});

app.post('/startlists/:id/activate', requireSpolei, (req, res) => {
  const { id } = req.params;
  if (!startlists[id]) return res.status(404).json({ error: 'Nicht gefunden' });
  activeStartlistId = id;
  saveStartlistsToDisk();
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
  res.json({ ok: true });
});

app.delete('/groups', requireSpolei, (req, res) => {
  groups = [];
  pushAutoDisplays();
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
      if (!id || typeof lat !== 'number' || typeof lon !== 'number') return;
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
});
