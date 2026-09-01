// =======================
// VERANSTALTUNGEN & RENNEN - DATENSCHICHT
// =======================
// Reine API-Huelle: kein DOM, kein Rendern. Die Ansicht liegt in
// race/events-ui.js und liest ausschliesslich aus eventList /
// activeRaceId, damit es nur eine Quelle der Wahrheit gibt.
//
// Ladereihenfolge: muss VOR events-ui.js und taktik-ui.js stehen.

let eventList    = [];     // [{id,name,ort,dateFrom,dateTo,races:[...]}]
// Ab 2.4.0 heisst activeRaceId "das Rennen, an dem DIESES GERAET
// arbeitet" - nicht mehr zwangslaeufig das Leitrennen des Servers.
// Die Bedeutung wandert bewusst in die bestehende Variable: an ihr
// haengen Favoriten, Fahrerstatus, Abstandsverlauf, Zeitmessung und
// Bewegungen. Ein zweiter Name daneben haette jede dieser Stellen
// einzeln umgebaut werden muessen - und race/favorites.js bleibt so
// unberuehrt.
let activeRaceId = null;
// Das Leitrennen des Servers. Reine Rueckfallebene: laeuft nur ein
// Rennen oder ist noch keins gewaehlt, ist es das Arbeitsrennen.
let leitRaceId   = null;

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

// Welches Rennen soll dieses Geraet bearbeiten? Dieselbe Wahl wie auf
// der Karte: das eigene Rennen aus der Rennleiste, sonst das
// Leitrennen. Damit zeigen Karte, Streifen und Taktik immer dasselbe.
function arbeitsRaceId() {
  const eigen = (typeof meinRaceId === 'function') ? meinRaceId() : null;
  if (eigen && findRace(eigen)) return eigen;
  return leitRaceId;
}

// Nach jeder Aenderung an Rennliste oder Auswahl aufrufen. Wechselt das
// Arbeitsrennen, wird der komplette Taktik-Stand neu geholt - der alte
// gehoert einem anderen Rennen und darf nicht stehenbleiben.
function arbeitsRennenPruefen() {
  const soll = arbeitsRaceId();
  if (soll === activeRaceId) {
    if (typeof renderStrip === 'function') renderStrip(taktikGroups);
    return;
  }
  activeRaceId = soll;
  if (typeof arbeitsRennenNachladen === 'function') arbeitsRennenNachladen();
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
  if (!res.ok) {
    // Bei 401/403 raeumt checkAuth() den Token weg und oeffnet den Login.
    if (!checkAuth(res)) throw new Error('Sitzung abgelaufen \u2013 bitte neu anmelden');
    throw new Error((data && data.error) || `Serverfehler ${res.status}`);
  }
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
    leitRaceId   = data.activeRaceId || null;
    arbeitsRennenPruefen();
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

// Beendet das aktive Rennen, ohne ein anderes zu aktivieren. Danach ist
// kein Rennen aktiv - der Aufrufer muss Gruppen und Strecke neu laden.
async function deactivateRaceById(id) {
  await apiSend(`/races/${id}/deactivate`, 'POST');
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
// Der Endpoint verlangt jetzt eine Anmeldung - die Antwort enthaelt
// Gruppenzusammensetzung und Startnummern. minutes begrenzt das Fenster
// schon serverseitig; frueher kam die komplette Historie und wurde hier
// bis auf die letzten Minuten weggeworfen.
// Sollrunden, Start/Ziel-Versatz und Zaehlerstand. Liegen in raceMeta
// und haben deshalb einen eigenen Endpoint neben PATCH /races/:id.
async function setRaceLaps(id, felder) {
  return apiSend(`/races/${id}/laps`, 'PATCH', felder);
}

// Streckenmarker anlegen oder aendern. Ohne id entsteht ein neuer.
// Die Antwort enthaelt die vollstaendige, nach km sortierte Liste.
async function saveMarker(raceId, felder) {
  return apiSend(`/races/${raceId}/marker`, 'POST', felder);
}

async function deleteMarker(raceId, mid) {
  return apiSend(`/races/${raceId}/marker/${mid}`, 'DELETE');
}

async function loadRaceGaps(id, minutes) {
  if (!authToken) return [];
  try {
    const res = await fetch(`${SERVER}/races/${id}/gaps?minutes=${minutes || 10}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (!res.ok) { checkAuth(res); return []; }
    const data = await res.json();
    return Array.isArray(data.snapshots) ? data.snapshots : [];
  } catch (e) { console.error('Gaps:', e); return []; }
}

// Fahrer des aktiven Rennens - fuer den Startlisten-Editor.
// raceId waehlt das Rennen; ohne Argument das Arbeitsrennen. Der
// Favoriteneditor ruft ohne Argument - und bekommt damit die Fahrer
// des Rennens, das er auch bearbeitet.
async function loadActiveRiders(raceId) {
  const id = raceId || activeRaceId;
  try {
    const res = await fetch(`${SERVER}/races/active${id ? `?race=${encodeURIComponent(id)}` : ''}`);
    return await res.json();
  } catch (e) { console.error('Active riders:', e); return []; }
}
