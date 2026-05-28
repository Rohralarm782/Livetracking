const express = require('express');
const cors    = require('cors');
const mqtt    = require('mqtt');

const app = express();

// =======================
// MIDDLEWARE
// =======================
app.use(cors());
app.use(express.json());

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

// =======================
// MQTT SUBSCRIBER
// Tracker sendet per MQTT (plain TCP, kein SSL)
// Server empfängt und speichert in positions{}
// =======================
const MQTT_BROKER = 'mqtt://broker.emqx.io:1883';
const MQTT_TOPIC  = 'livetracking-fq4l/#';  // Wildcard: alle Subtopics empfangen

const mqttClient = mqtt.connect(MQTT_BROKER, {
  clientId: 'livetracking-server-' + Math.random().toString(16).slice(2, 10),
  clean: true,
  reconnectPeriod: 5000
});

mqttClient.on('connect', () => {
  console.log('📡 MQTT verbunden mit broker.emqx.io');
  mqttClient.subscribe(MQTT_TOPIC, (err) => {
    if (err) console.error('❌ MQTT subscribe Fehler:', err);
    else     console.log('✅ Abonniert:', MQTT_TOPIC);
  });
});

mqttClient.on('message', (topic, message) => {
  console.log('📨 MQTT empfangen – Topic:', topic, '| Payload:', message.toString());
  try {
    const { id, lat, lon } = JSON.parse(message.toString());
    if (!id || typeof lat !== 'number' || typeof lon !== 'number') return;
    positions[id] = { lat, lon, timestamp: Date.now() };
    console.log('📍 MQTT Position:', id, positions[id]);
  } catch (e) {
    console.error('❌ MQTT parse Fehler:', e.message);
  }
});

mqttClient.on('error', (err) => {
  console.error('❌ MQTT Fehler:', err.message);
});

mqttClient.on('reconnect', () => {
  console.log('🔄 MQTT reconnect...');
});

// =======================
// HEALTH CHECK
// =======================
app.get('/health', (req, res) => {
  res.send('🚀 Tracking Server läuft');
});

// =======================
// POSITIONEN SPEICHERN (HTTP – bleibt als Fallback)
// =======================
app.post('/positions', (req, res) => {
  const { id, lat, lon } = req.body;

  if (!id || typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ error: 'id, lat, lon required' });
  }

  positions[id] = { lat, lon, timestamp: Date.now() };
  console.log("📍 HTTP Position:", id, positions[id]);
  res.json({ ok: true });
});

// =======================
// POSITIONEN LADEN
// =======================
app.get('/positions', (req, res) => {
  res.json(positions);
});

// =======================
// RESET
// =======================
app.delete('/positions', (req, res) => {
  const keys = Object.keys(positions);
  if (keys.length === 0) return res.json({ ok: true, message: "already empty" });
  keys.forEach(k => delete positions[k]);
  console.log("🧹 ALLE POSITIONEN GELÖSCHT");
  res.json({ ok: true, message: "cleared" });
});

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
});
