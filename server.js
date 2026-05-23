const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

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
// CONFIG
// =======================
const ADMIN_PASSWORD = 'admin123'; // ⚠️ ÄNDERN SIE DAS!
const TOKENS = new Set();

// =======================
// STATE
// =======================
let positions = Object.create(null);
let trackerNames = Object.create(null); // { deviceId: "Custom Name" }
let teamPosition = null; // { lat, lon, timestamp }

// =======================
// AUTH MIDDLEWARE
// =======================
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token || !TOKENS.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
}

// =======================
// LOGIN
// =======================
app.post('/login', (req, res) => {
  const { password } = req.body;

  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Wrong password' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  TOKENS.add(token);

  console.log('🔓 Login erfolgreich, Token:', token.substring(0, 8) + '...');

  res.json({ ok: true, token });
});

// =======================
// LOGOUT
// =======================
app.post('/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) TOKENS.delete(token);
  res.json({ ok: true });
});

// =======================
// HEALTH CHECK
// =======================
app.get('/health', (req, res) => {
  res.send('🚀 Tracking Server läuft');
});

// =======================
// POSITIONEN SPEICHERN (geräte-seitig)
// =======================
app.post('/positions', (req, res) => {
  const { id, lat, lon } = req.body;

  if (!id || typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({
      error: 'id (string), lat (number), lon (number) required'
    });
  }

  // Validierung
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  positions[id] = {
    lat,
    lon,
    timestamp: Date.now()
  };

  console.log("📍 gespeichert:", id, positions[id]);

  res.json({ ok: true });
});

// =======================
// TEAMAUTO-POSITION (authentifiziert)
// =======================
app.post('/team-position', authMiddleware, (req, res) => {
  const { lat, lon } = req.body;

  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({
      error: 'lat (number), lon (number) required'
    });
  }

  // Validierung
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  teamPosition = {
    lat,
    lon,
    timestamp: Date.now()
  };

  console.log("🚗 Teamauto-Position:", teamPosition);

  res.json({ ok: true });
});

// =======================
// POSITIONEN LADEN
// =======================
app.get('/positions', (req, res) => {
  const response = Object.assign({}, positions);
  
  // Teamauto-Position mit spezieller ID hinzufügen
  if (teamPosition) {
    response['TEAMAUTO'] = teamPosition;
  }

  // Tracker-Namen anwenden
  const withNames = {};
  for (const id in response) {
    const displayName = trackerNames[id] || id;
    withNames[displayName] = response[id];
  }

  res.json(withNames);
});

// =======================
// TRACKER UMBENENNEN (authentifiziert)
// =======================
app.post('/rename-tracker', authMiddleware, (req, res) => {
  const { oldName, newName } = req.body;

  if (!oldName || !newName) {
    return res.status(400).json({
      error: 'oldName and newName required'
    });
  }

  // Alte Position unter neuem Namen speichern
  if (positions[oldName]) {
    positions[newName] = positions[oldName];
    delete positions[oldName];
  }

  // Namen-Mapping speichern
  if (oldName !== 'TEAMAUTO') {
    trackerNames[newName] = newName;
    if (oldName !== newName) {
      delete trackerNames[oldName];
    }
  }

  console.log(`✏️ Tracker umbenannt: "${oldName}" → "${newName}"`);

  res.json({ ok: true });
});

// =======================
// 🧹 RESET (DELETE)
// =======================
app.delete('/positions', authMiddleware, (req, res) => {
  const keys = Object.keys(positions);

  if (keys.length === 0 && !teamPosition) {
    return res.json({ ok: true, message: "already empty" });
  }

  for (const key of keys) {
    delete positions[key];
  }

  teamPosition = null;
  trackerNames = Object.create(null);

  console.log("🧹 ALLE POSITIONEN GELÖSCHT");

  res.json({ ok: true, message: "cleared" });
});

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
  console.log(`⚠️  Admin Password: ${ADMIN_PASSWORD}`);
});
