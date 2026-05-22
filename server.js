const express = require('express');
const cors = require('cors');

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
// HEALTH CHECK
// =======================
app.get('/health', (req, res) => {
  res.send('🚀 Tracking Server läuft');
});

// =======================
// KEEPALIVE PING (vom Tracker alle 30s)
// Verhindert Railway-Sleep bei stationärem Gerät
// =======================
app.get('/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// =======================
// POSITIONEN SPEICHERN
// =======================
app.post('/positions', (req, res) => {
  const { id, lat, lon, bat } = req.body;

  if (!id || typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({
      error: 'id (string), lat (number), lon (number) required'
    });
  }

  positions[id] = {
    lat,
    lon,
    // bat nur speichern wenn als Zahl mitgesendet
    ...(typeof bat === 'number' && { bat }),
    timestamp: Date.now()
  };

  console.log("📍 gespeichert:", id, positions[id]);

  res.json({ ok: true });
});

// =======================
// POSITIONEN LADEN
// =======================
app.get('/positions', (req, res) => {
  res.json(positions);
});

// =======================
// 🧹 RESET (DELETE)
// =======================
app.delete('/positions', (req, res) => {
  const keys = Object.keys(positions);

  if (keys.length === 0) {
    return res.json({ ok: true, message: "already empty" });
  }

  for (const key of keys) {
    delete positions[key];
  }

  console.log("🧹 ALLE POSITIONEN GELÖSCHT");
  res.json({ ok: true, message: "cleared" });
});

// =======================
// FEHLERBEHANDLUNG
// Verhindert Serverabsturz bei unbehandelten Fehlern
// =======================
process.on('uncaughtException', (err) => {
  console.error('💥 Unbehandelter Fehler:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Unbehandelte Promise-Rejection:', reason);
});

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
});
