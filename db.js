// =======================
// db.js - Persistenz (Neon / Postgres)
// =======================
// Ohne DATABASE_URL laeuft der Server exakt wie vorher weiter:
// enabled = false, alle Funktionen sind No-ops bzw. liefern leere Daten.
// Damit kann ein Deploy ohne gesetzte Env-Var nichts kaputt machen.
//
// Datenmodell:
//   events      Veranstaltung (Schierke 2026, Bundesliga Lauf 3, ...)
//   races       Rennen innerhalb einer Veranstaltung. Traegt Startliste
//               (riders_json) und den aktuellen Taktik-Stand (groups_json).
//   gap_history Ereignis-basiert: jede Gruppen-Aenderung eine Zeile.
//   settings    Key/Value fuer Globales (aktives Rennen, GPX).

const { Pool } = require('pg');

const CONN    = process.env.DATABASE_URL || '';
const enabled = CONN.length > 0;

let pool = null;
if (enabled) {
  pool = new Pool({
    connectionString:        CONN,
    ssl:                     { rejectUnauthorized: false },
    max:                     3,      // Neon Free ist knapp bei Connections
    idleTimeoutMillis:       30000,
    connectionTimeoutMillis: 15000
  });
  // Ohne diesen Handler beendet ein Idle-Fehler den Prozess.
  pool.on('error', e => console.error('❌ PG Pool:', e.message));
}

async function q(text, params) {
  if (!enabled) return { rows: [] };
  return pool.query(text, params);
}

// =======================
// SCHEMA
// =======================
async function init() {
  if (!enabled) {
    console.log('💾 Keine DATABASE_URL gesetzt – Persistenz deaktiviert (RAM/Disk wie bisher)');
    return false;
  }
  await q(`CREATE TABLE IF NOT EXISTS events (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    ort        TEXT,
    date_from  DATE,
    date_to    DATE,
    notes      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  // Spaltennamen bewusst mit _json: "groups" ist in Postgres ein
  // Keyword (Window-Frames) und muesste sonst ueberall gequotet werden.
  await q(`CREATE TABLE IF NOT EXISTS races (
    id          TEXT PRIMARY KEY,
    event_id    TEXT REFERENCES events(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    category    TEXT,
    start_time  TIMESTAMPTZ,
    distance_km NUMERIC,
    laps        INTEGER,
    status      TEXT NOT NULL DEFAULT 'geplant',
    riders_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    groups_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    gpx_json    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  await q(`CREATE TABLE IF NOT EXISTS gap_history (
    id       BIGSERIAL PRIMARY KEY,
    race_id  TEXT REFERENCES races(id) ON DELETE CASCADE,
    ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
    snapshot JSONB NOT NULL
  )`);
  await q(`CREATE INDEX IF NOT EXISTS gap_history_race_ts ON gap_history (race_id, ts)`);

  await q(`CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value JSONB
  )`);

  console.log('💾 Datenbank verbunden, Schema geprüft');
  return true;
}

// =======================
// SETTINGS
// =======================
async function getSetting(key) {
  const r = await q('SELECT value FROM settings WHERE key = $1', [key]);
  return r.rows.length ? r.rows[0].value : null;
}

async function setSetting(key, value) {
  await q(`INSERT INTO settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [key, value === undefined ? null : JSON.stringify(value)]);
}

// =======================
// EVENTS
// =======================
async function listEvents() {
  const r = await q('SELECT * FROM events ORDER BY date_from DESC NULLS LAST, created_at DESC');
  return r.rows;
}

async function upsertEvent(ev) {
  await q(`INSERT INTO events (id, name, ort, date_from, date_to, notes)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name, ort = EXCLUDED.ort,
             date_from = EXCLUDED.date_from, date_to = EXCLUDED.date_to,
             notes = EXCLUDED.notes`,
          [ev.id, ev.name, ev.ort || null, ev.dateFrom || null, ev.dateTo || null, ev.notes || null]);
}

async function deleteEvent(id) {
  await q('DELETE FROM events WHERE id = $1', [id]);
}

// =======================
// RACES
// =======================
async function listRaces() {
  const r = await q('SELECT * FROM races ORDER BY created_at ASC');
  return r.rows;
}

// Legt an oder aktualisiert Stammdaten + Startliste.
// groups_json wird hier NICHT angefasst: der Taktik-Stand hat mit
// updateRaceGroups() einen eigenen Schreibpfad, sonst wuerde ein
// Startlisten-Update die laufenden Gruppen ueberbuegeln.
async function upsertRace(race) {
  await q(`INSERT INTO races (id, event_id, name, category, start_time,
                              distance_km, laps, status, riders_json, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, COALESCE($10, now()))
           ON CONFLICT (id) DO UPDATE SET
             event_id    = EXCLUDED.event_id,
             name        = EXCLUDED.name,
             category    = EXCLUDED.category,
             start_time  = EXCLUDED.start_time,
             distance_km = EXCLUDED.distance_km,
             laps        = EXCLUDED.laps,
             status      = EXCLUDED.status,
             riders_json = EXCLUDED.riders_json,
             updated_at  = now()`,
          [race.id, race.eventId || null, race.name, race.category || null,
           race.startTime || null, race.distanceKm || null, race.laps || null,
           race.status || 'geplant', JSON.stringify(race.riders || []),
           race.createdAt || null]);
}

async function updateRaceGroups(raceId, groups) {
  await q('UPDATE races SET groups_json = $2::jsonb, updated_at = now() WHERE id = $1',
          [raceId, JSON.stringify(groups || [])]);
}

async function updateRaceGpx(raceId, gpx) {
  await q('UPDATE races SET gpx_json = $2::jsonb, updated_at = now() WHERE id = $1',
          [raceId, gpx == null ? null : JSON.stringify(gpx)]);
}

async function deleteRace(id) {
  await q('DELETE FROM races WHERE id = $1', [id]);
}

// =======================
// ABSTANDSVERLAUF
// =======================
// Ereignis-basiert: wird bei jedem Speichern der Gruppen gerufen.
// Dedupe gegen den letzten Snapshot, damit doppelte Saves der UI
// keine Karteileichen erzeugen.
let lastSnapshotKey = '';

async function addGapSnapshot(raceId, groups) {
  if (!enabled || !raceId) return;
  const snapshot = (Array.isArray(groups) ? groups : []).map(g => ({
    label:  g.label || g.name || null,
    gap:    g.gap != null ? String(g.gap) : null,
    riders: (g.riders || []).map(r => (r && r.nr !== undefined) ? r.nr : r)
  }));
  const key = raceId + '|' + JSON.stringify(snapshot);
  if (key === lastSnapshotKey) return;
  lastSnapshotKey = key;
  await q('INSERT INTO gap_history (race_id, snapshot) VALUES ($1, $2::jsonb)',
          [raceId, JSON.stringify(snapshot)]);
}

async function listGapHistory(raceId) {
  const r = await q('SELECT ts, snapshot FROM gap_history WHERE race_id = $1 ORDER BY ts ASC',
                    [raceId]);
  return r.rows;
}

module.exports = {
  enabled, init,
  getSetting, setSetting,
  listEvents, upsertEvent, deleteEvent,
  listRaces, upsertRace, updateRaceGroups, updateRaceGpx, deleteRace,
  addGapSnapshot, listGapHistory
};
