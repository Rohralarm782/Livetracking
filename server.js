const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
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

// =======================
// MQTT-BRIDGE  (Tracker -> positions)
// =======================
const MQTT_URL   = process.env.MQTT_URL   || 'mqtt://broker.emqx.io:1883';
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'livetracking-fq4l/positions';

const mqttClient = mqtt.connect(MQTT_URL, {
  reconnectPeriod: 5000,
  connectTimeout: 30000,
});

mqttClient.on('connect', () => {
  console.log('🔌 MQTT verbunden mit', MQTT_URL);
  mqttClient.subscribe(MQTT_TOPIC, (err) => {
    if (err) console.error('❌ MQTT subscribe Fehler:', err.message);
    else     console.log('📡 Abonniert:', MQTT_TOPIC);
  });
});

mqttClient.on('message', (topic, payload) => {
  const raw = payload.toString();
  try {
    const { id, lat, lon } = JSON.parse(raw);
    if (!id || typeof lat !== 'number' || typeof lon !== 'number') {
      console.warn('⚠️ MQTT ungültige Nachricht:', raw);
      return;
    }
    positions[id] = { lat, lon, timestamp: Date.now() };
    console.log('📍 MQTT Position:', id, positions[id]);
  } catch (e) {
    console.error('💥 MQTT Parse-Fehler:', e.message, '|', raw);
  }
});

mqttClient.on('reconnect', () => console.log('🔄 MQTT reconnect...'));
mqttClient.on('offline',   () => console.log('📴 MQTT offline'));
mqttClient.on('error',     (err) => console.error('💥 MQTT Fehler:', err.message));

// =======================
// AUTH
// =======================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const tokens = new Set();
function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = auth.slice(7);
  if (!tokens.has(token)) {
    return res.status(401).json({ error: 'Invalid token' });
  }
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
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  tokens.add(token);
  res.json({ token });
});

app.post('/logout', requireAuth, (req, res) => {
  const token = req.headers['authorization'].slice(7);
  tokens.delete(token);
  res.json({ ok: true });
});

// =======================
// POSITIONEN
// =======================
app.post('/positions', (req, res) => {
  const { id, lat, lon } = req.body;
  if (!id || typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ error: 'id, lat, lon required' });
  }
  positions[id] = { lat, lon, timestamp: Date.now() };
  console.log("📍 Position:", id, positions[id]);
  res.json({ ok: true });
});

app.get('/positions', (req, res) => {
  res.json(positions);
});

app.delete('/positions', requireAuth, (req, res) => {
  for (const key of Object.keys(positions)) delete positions[key];
  console.log("🧹 Positionen gelöscht");
  res.json({ ok: true });
});

// =======================
// TEAM-POSITION
// =======================
app.post('/team-position', requireAuth, (req, res) => {
  const { lat, lon } = req.body;
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ error: 'lat, lon required' });
  }
  positions['TEAMAUTO'] = { lat, lon, timestamp: Date.now() };
  res.json({ ok: true });
});

// =======================
// RENAME TRACKER
// =======================
app.post('/rename-tracker', requireAuth, (req, res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName) return res.status(400).json({ error: 'oldName, newName required' });
  if (positions[oldName]) {
    positions[newName] = positions[oldName];
    delete positions[oldName];
  }
  res.json({ ok: true });
});

// =======================
// GPX TRACK
// =======================
app.get('/gpx', (req, res) => {
  res.json(gpxTrack || null);
});

app.post('/gpx', requireAuth, (req, res) => {
  const { coords, name } = req.body;
  if (!Array.isArray(coords) || coords.length === 0) {
    return res.status(400).json({ error: 'coords array required' });
  }
  gpxTrack = { coords, name: name || 'GPX Track' };
  console.log(`📂 GPX gespeichert: ${name} (${coords.length} Punkte)`);
  res.json({ ok: true });
});

app.delete('/gpx', requireAuth, (req, res) => {
  gpxTrack = null;
  console.log("🗑️ GPX gelöscht");
  res.json({ ok: true });
});

// =======================
// START
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
});
