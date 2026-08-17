// =======================
// VERANSTALTUNGEN & RENNEN - DATENSCHICHT
// =======================
// Reine API-Huelle: kein DOM, kein Rendern. Die Ansicht liegt in
// race/events-ui.js und liest ausschliesslich aus eventList /
// activeRaceId, damit es nur eine Quelle der Wahrheit gibt.
//
// Ladereihenfolge: muss VOR events-ui.js und taktik-ui.js stehen.

let eventList    = [];     // [{id,name,ort,dateFrom,dateTo,races:[...]}]
let activeRaceId = null;

// Flache Sicht ueber alle Rennen - fuer Lookups per id.
function allRaces() {
  return eventList.flatMap(ev => ev.races || []);
}

function findRace(id) {
  return allRaces().find(r => r.id === id) || null;
}

function activeRace() {
  return activeRaceId ? findRace(activeRaceId) : null;
}

function eventOfRace(id) {
  const r = findRace(id);
  return r ? eventList.find(ev => ev.id === r.eventId) || null : null;
}

// Anzeigename fuer Kopfzeilen: "U17m Straße" bzw. "U17m Straße · Schierke 2026"
function raceLabel(id, withEvent = false) {
  const r = findRace(id);
  if (!r) return '';
  if (!withEvent) return r.name;
  const ev = eventOfRace(id);
  return (ev && ev.id !== 'archiv') ? `${r.name} \u00B7 ${ev.name}` : r.name;
}

async function apiSend(path, method, body) {
  const opt = {
    method,
    headers: { 'Authorization': `Bearer ${authToken}` }
  };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(`${SERVER}${path}`, opt);
  let data = null;
  try { data = await res.json(); } catch (e) { /* leere Antwort ist ok */ }
  if (!res.ok) throw new Error((data && data.error) || `Serverfehler ${res.status}`);
  return data;
}

// =======================
// LADEN
// =======================
async function loadEvents() {
  try {
    const res  = await fetch(`${SERVER}/events`);
    const data = await res.json();
    eventList    = data.events       || [];
    activeRaceId = data.activeRaceId || null;
  } catch (e) { console.error('Events:', e); }
}

// =======================
// VERANSTALTUNGEN
// =======================
async function createEvent({ name, ort, dateFrom, dateTo }) {
  const data = await apiSend('/events', 'POST', { name, ort, dateFrom, dateTo });
  await loadEvents();
  return data.id;
}

async function updateEvent(id, patch) {
  await apiSend(`/events/${id}`, 'PATCH', patch);
  await loadEvents();
}

// Nimmt alle Rennen der Veranstaltung mit. Der Server blockt mit 409,
// solange das aktive Rennen darin liegt.
async function deleteEvent(id) {
  await apiSend(`/events/${id}`, 'DELETE');
  await loadEvents();
}

// =======================
// RENNEN
// =======================
async function createRace({ eventId, name, category, startTime, riders }) {
  const data = await apiSend('/races', 'POST', { eventId, name, category, startTime, riders });
  await loadEvents();
  return data.id;
}

async function updateRace(id, patch) {
  await apiSend(`/races/${id}`, 'PATCH', patch);
  await loadEvents();
}

// Startliste setzen bzw. ersetzen - Ziel des Imports.
async function setRaceRiders(id, riders) {
  await apiSend(`/races/${id}/riders`, 'PUT', { riders });
  await loadEvents();
}

// Wechselt das aktive Rennen. Der Taktik-Stand des alten Rennens bleibt
// dort gespeichert, der des neuen wird geladen - deshalb muss der
// Aufrufer danach die Gruppenansicht neu zeichnen.
async function activateRaceById(id) {
  await apiSend(`/races/${id}/activate`, 'POST');
  await loadEvents();
}

async function deleteRace(id) {
  await apiSend(`/races/${id}`, 'DELETE');
  await loadEvents();
}

// Strecke setzen bzw. ersetzen. Das Rennen muss dafuer nicht aktiv
// sein - so laesst sich ein ganzes Wochenende vorbereiten.
async function setRaceGpx(id, coords, name) {
  await apiSend(`/races/${id}/gpx`, 'PUT', { coords, name });
  await loadEvents();
}

async function deleteRaceGpx(id) {
  await apiSend(`/races/${id}/gpx`, 'DELETE');
  await loadEvents();
}

// Zustand eines Fahrers: 'warn' | 'dsq' | 'dnf' | null
async function setRiderStatus(raceId, nr, status) {
  await apiSend(`/races/${raceId}/rider-status`, 'POST', { nr, status });
}

// Einzelnen Fahrer anlegen oder aendern. newNr nur setzen, wenn die
// Startnummer selbst korrigiert wird.
async function saveRider(raceId, { nr, newNr, name, team }) {
  await apiSend(`/races/${raceId}/rider`, 'POST', { nr, newNr, name, team });
  await loadEvents();
}

// Bewusst NICHT removeRider(): so heisst in race/taktik.js schon das
// Herausnehmen aus einer Gruppe. Alle Dateien teilen sich einen
// globalen Scope - gleicher Name waere ein stiller Ueberschreiber.
async function deleteRiderFromRace(raceId, nr) {
  await apiSend(`/races/${raceId}/rider/${nr}`, 'DELETE');
  await loadEvents();
}

// Rennen kopieren: gleiche Startliste, keine Gruppen, keine Strecke.
async function duplicateRace(id, name) {
  const data = await apiSend(`/races/${id}/duplicate`, 'POST', name ? { name } : {});
  await loadEvents();
  return data.id;
}

// Abstandsverlauf des Rennens (aus gap_history).
async function loadRaceGaps(id) {
  try {
    const res  = await fetch(`${SERVER}/races/${id}/gaps`);
    const data = await res.json();
    return Array.isArray(data.snapshots) ? data.snapshots : [];
  } catch (e) { console.error('Gaps:', e); return []; }
}

// Fahrer des aktiven Rennens - fuer den Startlisten-Editor.
async function loadActiveRiders() {
  try {
    const res = await fetch(`${SERVER}/races/active`);
    return await res.json();
  } catch (e) { console.error('Active riders:', e); return []; }
}
