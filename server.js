const express = require('express');
const cors = require('cors');

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
let gpxTrack  = null;   // { coords: [[lat,lon], ...], name: string }

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

// Jeder eingeloggte Nutzer (jedes Level)
function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);
  const entry = tokens.get(token);
  if (!entry) return res.status(401).json({ error: 'Invalid token' });
  req.userLevel = entry.level;
  next();
}

// Nur SpoLei (Admin)
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
// POSITIONEN (GPS-Tracker → kein Auth nötig)
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
  res.json(positions);
});

app.delete('/positions', requireSpolei, (req, res) => {
  for (const key of Object.keys(positions)) delete positions[key];
  console.log("🧹 Positionen gelöscht");
  res.json({ ok: true });
});

// =======================
// BETREUER-POSITION
// Jeder eingeloggte Nutzer kann seinen Standort einmalig setzen.
// Marker erscheint auf der Karte mit Name (z.B. "Heinz – VP KM 45").
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
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 30);
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
// =======================
app.post('/rename-tracker', requireSpolei, (req, res) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName) return res.status(400).json({ error: 'oldName, newName required' });
  if (positions[oldName]) {
    positions[newName] = positions[oldName];
    delete positions[oldName];
  }
  res.json({ ok: true });
});

// =======================
// GPX TRACK (SpoLei only)
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
// START
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
});
