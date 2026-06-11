const express = require('express');
const cors    = require('cors');
const mqtt    = require('mqtt');

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
// SIMPLE AUTH
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
// AUTH
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
  const { id, lat, lon, bat, mode } = req.body;
  if (!id || typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ error: 'id, lat, lon required' });
  }
  // Hardware-ID bleibt immer der Key
  positions[id] = { lat, lon, timestamp: Date.now() };
  if (typeof bat === 'number') positions[id].bat = bat;
  if (mode === 'training' || mode === 'race') positions[id].trackerMode = mode;
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
  // Nur Anzeigename setzen – Hardware-ID und positions-Key bleiben unverändert
  trackerDisplayNames[trackerId] = newName.trim();
  console.log(`✏️ Tracker "${trackerId}" → "${newName}"`);
  res.json({ ok: true });
});

// =======================
// MODUS (training / race)
// =======================
app.get('/mode', (req, res) => {
  res.json({ mode: currentMode });
});

app.post('/mode', requireAuth, (req, res) => {
  const { mode } = req.body;
  if (mode !== 'training' && mode !== 'race') {
    return res.status(400).json({ error: 'mode must be "training" or "race"' });
  }
  currentMode = mode;
  console.log(`🔄 Modus: ${mode}`);
  // Retained MQTT-Nachricht → alle Firmware-Instanzen holen sich den neuen Modus
  mqttClient.publish('livetracking-fq4l/config', mode, { retain: true, qos: 0 }, err => {
    if (err) console.error('❌ MQTT config publish:', err.message);
    else     console.log(`📡 MQTT config → "${mode}" (retained)`);
  });
  res.json({ ok: true, mode });
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
const MQTT_BROKER = 'mqtt://broker.emqx.io:1883';
const MQTT_TOPIC  = 'livetracking-fq4l/positions';

let mqttClient = null; // modul-global → wird von /mode-Endpoint genutzt

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
