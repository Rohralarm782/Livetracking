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
//   track_points Gefahrene Spur je Tracker. Bewusst ohne Bezug auf
//               races: die Spur haengt am Geraet, nicht am Rennen, und
//               ueberlebt einen Rennenwechsel. Wird nach 24 Stunden
//               automatisch verworfen.

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

  // Spur je Tracker. Keine Fremdschluessel: ein Tracker kann melden,
  // bevor ein Rennen angelegt ist, und ein geloeschtes Rennen darf die
  // laufende Aufzeichnung nicht mitreissen. t als BIGINT statt
  // TIMESTAMPTZ - der Server rechnet durchgaengig in Millisekunden,
  // und eine Umrechnung an der Schreibstelle waere eine Fehlerquelle
  // ohne Gegenwert.
  await q(`CREATE TABLE IF NOT EXISTS track_points (
    id         BIGSERIAL PRIMARY KEY,
    tracker_id TEXT   NOT NULL,
    t          BIGINT NOT NULL,
    lat        DOUBLE PRECISION NOT NULL,
    lon        DOUBLE PRECISION NOT NULL
  )`);
  await q(`CREATE INDEX IF NOT EXISTS track_points_id_t ON track_points (tracker_id, t)`);

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

// minutes begrenzt das Fenster schon in der Datenbank. Ohne das wuchs
// die Antwort ueber ein langes Rennen auf hunderte Snapshots an, von
// denen das Frontend ohnehin nur die letzten Minuten auswertet - und
// das alle 30 Sekunden ueber Mobilfunk.
// Fuer den CSV-Export: der komplette Verlauf, ohne Zeitfenster.
// Bewusst eine eigene Funktion statt eines Sonderwerts bei minutes -
// so kann das Fenster im Live-Betrieb nicht versehentlich wegfallen.
async function listGapHistoryAll(raceId) {
  const r = await q('SELECT ts, snapshot FROM gap_history WHERE race_id = $1 ORDER BY ts ASC',
                    [raceId]);
  return r.rows;
}

async function listGapHistory(raceId, minutes) {
  const m = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 10;
  const r = await q(
    `SELECT ts, snapshot FROM gap_history
      WHERE race_id = $1 AND ts > now() - ($2 || ' minutes')::interval
      ORDER BY ts ASC`,
    [raceId, String(m)]);
  return r.rows;
}

// =======================
// SPUR (track_points)
// =======================
// Geschrieben wird gebuendelt, nicht je Punkt: bei zwoelf Trackern im
// 5-Sekunden-Takt waeren das 2,4 Inserts pro Sekunde ueber die ganze
// Renndauer - fuer Neon Free zu viel. Der Server sammelt und ruft das
// hier alle paar Sekunden mit einem Stapel auf.
async function addTrackPoints(punkte) {
  if (!enabled || !Array.isArray(punkte) || !punkte.length) return;
  const werte = [];
  const teile = [];
  punkte.forEach((p, i) => {
    const b = i * 4;
    teile.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`);
    werte.push(p.id, p.t, p.lat, p.lon);
  });
  await q(`INSERT INTO track_points (tracker_id, t, lat, lon) VALUES ${teile.join(', ')}`, werte);
}

// Beim Serverstart: die Spur der letzten Stunden zurueck in den
// Speicher. Ohne das haette ein Neustart auf Render - und die kommen
// auf dem Free-Tier von allein - die Spur des laufenden Rennens
// verschluckt, obwohl sie in der Datenbank steht.
async function listTrackPoints(abMs, maxProTracker) {
  if (!enabled) return {};
  const r = await q(
    `SELECT tracker_id, t, lat, lon FROM track_points
      WHERE t >= $1 ORDER BY tracker_id ASC, t ASC`, [abMs]);
  const out = Object.create(null);
  for (const row of r.rows) {
    const id = row.tracker_id;
    if (!out[id]) out[id] = [];
    out[id].push({ t: Number(row.t), lat: Number(row.lat), lon: Number(row.lon) });
  }
  if (Number.isFinite(maxProTracker) && maxProTracker > 0) {
    for (const id of Object.keys(out)) {
      if (out[id].length > maxProTracker) out[id] = out[id].slice(-maxProTracker);
    }
  }
  return out;
}

// trackerId weggelassen heisst: alles. Wird von "alle Positionen
// loeschen" gerufen, mit ID vom Entfernen eines einzelnen Markers.
async function deleteTrackPoints(trackerId) {
  if (!enabled) return;
  if (trackerId) await q('DELETE FROM track_points WHERE tracker_id = $1', [String(trackerId)]);
  else           await q('DELETE FROM track_points');
}

async function purgeTrackPoints(aelterAlsMs) {
  if (!enabled) return 0;
  const r = await q('DELETE FROM track_points WHERE t < $1', [aelterAlsMs]);
  return r.rowCount || 0;
}

module.exports = {
  enabled, init,
  getSetting, setSetting,
  listEvents, upsertEvent, getEvent, deleteEvent,
  listRaces, upsertRace, updateRaceRiders, setRaceStatus, clearActiveStatus,
  updateRaceGroups, updateRaceGpx, deleteRace,
  addGapSnapshot, listGapHistory, listGapHistoryAll,
  addTrackPoints, listTrackPoints, deleteTrackPoints, purgeTrackPoints
};
