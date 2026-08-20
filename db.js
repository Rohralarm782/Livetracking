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
//   track_points Rohe GPS-Punkte je Tracker. Ohne die existiert die
//               gefahrene Strecke nur als Leaflet-Polyline im jeweils
//               offenen Browser und ist nach Reload/Cold-Start weg.
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

  // race_id ist bewusst NULLABLE: Punkte kommen auch an, wenn kein
  // Rennen aktiv ist (Test, Training). Die Spalte wird heute aus dem
  // einen globalen activeRaceId gefuellt; sobald es eine echte
  // Tracker->Rennen-Zuordnung gibt, kommt sie von dort - ohne Migration.
  await q(`CREATE TABLE IF NOT EXISTS track_points (
    id         BIGSERIAL PRIMARY KEY,
    tracker_id TEXT NOT NULL,
    race_id    TEXT REFERENCES races(id) ON DELETE CASCADE,
    ts         TIMESTAMPTZ NOT NULL,
    lat        DOUBLE PRECISION NOT NULL,
    lon        DOUBLE PRECISION NOT NULL,
    acc        REAL,
    spd        REAL
  )`);
  await q(`CREATE INDEX IF NOT EXISTS track_points_tracker_ts ON track_points (tracker_id, ts)`);

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

async function getEvent(id) {
  const r = await q('SELECT * FROM events WHERE id = $1', [id]);
  return r.rows.length ? r.rows[0] : null;
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

// Nur die Startliste. Eigener Schreibpfad, damit ein Re-Import die
// Stammdaten und den Taktik-Stand nicht anfasst.
async function updateRaceRiders(raceId, riders) {
  await q('UPDATE races SET riders_json = $2::jsonb, updated_at = now() WHERE id = $1',
          [raceId, JSON.stringify(riders || [])]);
}

async function setRaceStatus(raceId, status) {
  await q('UPDATE races SET status = $2, updated_at = now() WHERE id = $1',
          [raceId, status]);
}

// Genau ein Rennen darf 'aktiv' sein. Wird vor dem Aktivieren gerufen,
// damit ein abgestuerzter Wechsel keine zwei aktiven Rennen hinterlaesst.
async function clearActiveStatus() {
  await q(`UPDATE races SET status = 'beendet', updated_at = now() WHERE status = 'aktiv'`);
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
  // id mitschreiben: der Abstandsverlauf wird im Frontend je Gruppe
  // ausgewertet, und ueber den Namen ist das nicht zuverlaessig -
  // Gruppen werden waehrend des Rennens umbenannt.
  const snapshot = (Array.isArray(groups) ? groups : []).map(g => ({
    id:     g.id || null,
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

// =======================
// STRECKENPUNKTE
// =======================
// Gesammelt geschrieben, nicht pro Punkt: bei 5s-Intervall mal mehreren
// Trackern waeren Einzel-INSERTs zu viele Round-Trips fuer Neon Free.
// Der Aufrufer puffert und ruft das hier alle paar Sekunden.
const TP_CHUNK = 500;   // Parameter pro Statement begrenzen (7 je Zeile)

async function insertTrackPoints(rows) {
  if (!enabled || !Array.isArray(rows) || rows.length === 0) return 0;
  let written = 0;
  for (let i = 0; i < rows.length; i += TP_CHUNK) {
    const chunk  = rows.slice(i, i + TP_CHUNK);
    const params = [];
    const values = [];
    for (const r of chunk) {
      const b = params.length;
      // ts kommt als Epoch-Millisekunden herein
      values.push(`($${b+1}, $${b+2}, to_timestamp($${b+3}::double precision / 1000.0), $${b+4}, $${b+5}, $${b+6}, $${b+7})`);
      params.push(r.trackerId, r.raceId == null ? null : r.raceId, r.ts,
                  r.lat, r.lon,
                  r.acc == null ? null : r.acc,
                  r.spd == null ? null : r.spd);
    }
    await q(`INSERT INTO track_points (tracker_id, race_id, ts, lat, lon, acc, spd)
             VALUES ${values.join(', ')}`, params);
    written += chunk.length;
  }
  return written;
}

// Aufraeumen je Tracker, nicht global nach Alter: solange ein Tracker
// sendet, bleibt seine komplette Spur stehen - auch bei langem Rennen.
// Erst wenn er idleSeconds nichts mehr geliefert hat, faellt sie weg.
async function pruneTrackPoints(idleSeconds) {
  if (!enabled) return 0;
  const r = await q(`DELETE FROM track_points WHERE tracker_id IN (
                       SELECT tracker_id FROM track_points
                       GROUP BY tracker_id
                       HAVING max(ts) < now() - make_interval(secs => $1)
                     )`, [idleSeconds]);
  return r.rowCount || 0;
}

module.exports = {
  enabled, init,
  getSetting, setSetting,
  listEvents, upsertEvent, getEvent, deleteEvent,
  listRaces, upsertRace, updateRaceRiders, setRaceStatus, clearActiveStatus,
  updateRaceGroups, updateRaceGpx, deleteRace,
  addGapSnapshot, listGapHistory,
  insertTrackPoints, pruneTrackPoints
};
