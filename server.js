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
  res.json({ ok: true });
});

app.delete('/groups', requireSpolei, (req, res) => {
  groups = [];
  console.log('🧹 Gruppen gelöscht');
  res.json({ ok: true });
});

// =======================
// MQTT BRIDGE
// =======================
const MQTT_BROKER = 'mqtt://broker.emqx.io:1883';
const MQTT_TOPIC  = 'livetracking-fq4l/positions';

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
    // Retained config-Nachricht beim (Re-)Connect wiederherstellen
    mqttClient.publish('livetracking-fq4l/config', currentMode, { retain: true, qos: 0 });
  });

  mqttClient.on('message', (topic, message) => {
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
