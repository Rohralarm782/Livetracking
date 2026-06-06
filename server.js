const express = require('express');
const cors = require('cors');

const app = express();

// =======================
// MIDDLEWARE
// =======================
app.use(cors());
app.use(express.json({ limit: '2mb' })); // GPX-Tracks können größer sein

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
let gpxTrack  = null;   // { coords: [[lat,lon], ...], name: string }
const trackerDisplayNames = Object.create(null); // hardwareId → Anzeigename (bleibt bei Reset erhalten)

// =======================
// SIMPLE AUTH (Token-basiert)
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
  // Hardware-ID bleibt immer der Key – displayName ist davon unabhängig
  positions[id] = { lat, lon, timestamp: Date.now() };
  res.json({ ok: true });
});

app.get('/positions', (req, res) => {
  // displayName wird on-the-fly ergänzt, ohne den Key zu verändern
  const result = Object.create(null);
  for (const id of Object.keys(positions)) {
    result[id] = Object.assign({}, positions[id], {
      displayName: trackerDisplayNames[id] || null
    });
  }
  res.json(result);
});

app.delete('/positions', requireAuth, (req, res) => {
  for (const key of Object.keys(positions)) delete positions[key];
  // trackerDisplayNames bewusst NICHT löschen – Umbenennung bleibt nach Reset erhalten
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
  const { trackerId, newName } = req.body;
  if (!trackerId || !newName) return res.status(400).json({ error: 'trackerId, newName required' });
  // Nur den Anzeigenamen setzen – Hardware-ID und positions-Key bleiben unverändert
  trackerDisplayNames[trackerId] = newName.trim();
  console.log(`✏️ Tracker "${trackerId}" → "${newName}"`);
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
// MQTT BRIDGE
// =======================
const mqtt = require('mqtt');

const MQTT_BROKER = 'mqtt://broker.emqx.io:1883';
const MQTT_TOPIC  = 'livetracking-fq4l/positions';

function connectMqtt() {
  const client = mqtt.connect(MQTT_BROKER, {
    clientId: 'render-server-' + Math.random().toString(36).slice(2),
    clean: true,
    reconnectPeriod: 5000,
  });

  client.on('connect', () => {
    console.log('✅ MQTT verbunden mit broker.emqx.io');
    client.subscribe(MQTT_TOPIC, (err) => {
      if (err) console.error('❌ MQTT Subscribe Fehler:', err);
      else      console.log(`📡 MQTT subscribed: ${MQTT_TOPIC}`);
    });
  });

  client.on('message', (topic, message) => {
    try {
      const data = JSON.parse(message.toString());
      const { id, lat, lon } = data;
      if (!id || typeof lat !== 'number' || typeof lon !== 'number') return;
      positions[id] = { lat, lon, timestamp: Date.now() };
      console.log(`📍 MQTT: ${id} → ${lat}, ${lon}`);
    } catch (e) {
      console.error('❌ MQTT Nachricht ungültig:', e.message);
    }
  });

  client.on('error',      (err) => console.error('❌ MQTT Fehler:', err.message));
  client.on('reconnect',  ()    => console.log('🔄 MQTT reconnect…'));
  client.on('disconnect', ()    => console.log('⚠️ MQTT getrennt'));
}

connectMqtt();

// =======================
// START
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
});
