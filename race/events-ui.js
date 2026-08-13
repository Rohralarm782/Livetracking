// =======================
// RENNVERWALTUNG (zweite Ansicht im Taktik-Tab)
// =======================
// Teilt sich die Vollansicht mit dem Taktik-Body: es ist immer genau
// einer der beiden sichtbar. Kein eigenes Overlay, damit Scrollposition
// und Header sich nicht in die Quere kommen.
//
// Reihenfolge im Ablauf: Veranstaltung anlegen -> Rennen mit AK anlegen
// -> Startliste importieren -> Rennen aktivieren.

const evBody = document.getElementById('eventsBody');

let eventsOpen   = false;
let evFormOpen   = false;   // Formular "Veranstaltung anlegen"
let evEditId     = null;    // Veranstaltung im Bearbeiten-Modus
let raceFormEvId = null;    // Veranstaltung, in der ein Rennen angelegt wird
let raceEditId   = null;    // Rennen im Bearbeiten-Modus

function resetEventForms() {
  evFormOpen = false; evEditId = null; raceFormEvId = null; raceEditId = null;
}

async function openEventsPanel() {
  eventsOpen = true;
  resetEventForms();
  document.getElementById('taktikBody').classList.add('hidden');
  evBody.classList.remove('hidden');
  document.getElementById('tkTitle').innerHTML = '\u{1F3C1} Rennen';
  document.getElementById('eventsBtn').innerHTML = '\u2190 Taktik';
  await loadEvents();
  renderEventsBody();
}

function closeEventsPanel() {
  eventsOpen = false;
  evBody.classList.add('hidden');
  document.getElementById('taktikBody').classList.remove('hidden');
  document.getElementById('tkTitle').innerHTML = '\u{1F4CA} Taktik';
  document.getElementById('eventsBtn').innerHTML = '\u{1F3C1} Rennen';
  renderTaktikBody();
}

function toggleEventsPanel() {
  if (eventsOpen) closeEventsPanel(); else openEventsPanel();
}

document.getElementById('eventsBtn').addEventListener('click', toggleEventsPanel);

// =======================
// HILFEN
// =======================
function fmtDay(iso) {
  if (!iso) return '';
  const d = String(iso).slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}.${d[1]}.${d[0]}` : '';
}

function evMeta(ev) {
  const parts = [];
  if (ev.ort) parts.push(ev.ort);
  const a = fmtDay(ev.dateFrom), b = fmtDay(ev.dateTo);
  if (a && b && a !== b) parts.push(`${a} \u2013 ${b}`);
  else if (a)            parts.push(a);
  return parts.join(' \u00B7 ');
}

function statusColor(r) {
  if (r.isActive)              return '#4caf50';
  if (r.status === 'beendet')  return '#bbb';
  return '#ddd';
}

// hh:mm aus einem ISO-Zeitstempel, leer wenn keiner gesetzt ist
function fmtStart(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// "10:30" am Renntag -> ISO. Ohne Datum der Veranstaltung nicht moeglich,
// dann wird die Zeit verworfen statt geraten.
function startTimeToIso(hhmm, dayIso) {
  if (!hhmm || !dayIso) return null;
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(`${String(dayIso).slice(0, 10)}T00:00:00`);
  if (isNaN(d)) return null;
  d.setHours(parseInt(m[1]), parseInt(m[2]), 0, 0);
  return d.toISOString();
}

function val(sel) {
  const el = evBody.querySelector(sel);
  return el ? el.value.trim() : '';
}

// =======================
// RENDERN
// =======================
function renderEventsBody() {
  if (!authToken) {
    evBody.innerHTML = `<div class="ev-empty">Nur f\u00FCr angemeldete Nutzer</div>`;
    return;
  }

  // Sammel-Event nur zeigen, wenn wirklich Rennen darin liegen
  const list = eventList.filter(ev => ev.id !== 'archiv' || (ev.races || []).length > 0);
  let html = '';

  if (list.length === 0 && !evFormOpen) {
    html += `<div class="ev-empty">Noch keine Veranstaltung \u2013 unten anlegen</div>`;
  }

  list.forEach(ev => {
    const races = ev.races || [];
    html += `<div class="ev-card">`;

    if (evEditId === ev.id) {
      html += `<div class="ev-form">
        <input type="text" id="evEditName" value="${escH(ev.name)}" placeholder="Name der Veranstaltung">
        <input type="text" id="evEditOrt"  value="${escH(ev.ort || '')}" placeholder="Ort">
        <div class="row">
          <input type="date" id="evEditFrom" value="${escH((ev.dateFrom || '').slice(0,10))}">
          <input type="date" id="evEditTo"   value="${escH((ev.dateTo   || '').slice(0,10))}">
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn" data-action="ev-edit-save" data-id="${ev.id}" style="flex:1">\u2713 Speichern</button>
          <button class="btn" data-action="ev-cancel" style="flex:0;padding:7px 12px">\u2715</button>
        </div>
      </div>`;
    } else {
      const meta = evMeta(ev);
      html += `<div class="ev-hdr">
        <div style="flex:1;min-width:0">
          <div class="ev-name">${escH(ev.name)}</div>
          ${meta ? `<div class="ev-meta">${escH(meta)}</div>` : ''}
        </div>
        <button class="btn" data-action="ev-edit" data-id="${ev.id}"
          style="flex:0;padding:4px 8px;font-size:12px">\u270E</button>
        <button class="btn" data-action="ev-del" data-id="${ev.id}"
          style="flex:0;padding:4px 8px;font-size:12px;color:#f44336">\u{1F5D1}</button>
      </div>`;
    }

    races.forEach(r => {
      if (raceEditId === r.id) {
        html += `<div class="ev-form">
          <input type="text" id="rcEditName" value="${escH(r.name)}" placeholder="Name des Rennens">
          <div class="row">
            <input type="text" id="rcEditAk"    value="${escH(r.category || '')}" placeholder="AK, z.B. U17m">
            <input type="text" id="rcEditStart" value="${escH(fmtStart(r.startTime))}" placeholder="Start hh:mm">
          </div>
          ${r.hasGpx ? `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
            <span style="flex:1;min-width:0;font-size:12px;color:#e65100;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\u{1F5FA} ${escH(r.gpxName || 'Strecke')}</span>
            <button class="btn" data-action="rc-gpx-del" data-id="${r.id}"
              style="flex:0;padding:5px 10px;font-size:12px;color:#f44336">Strecke entfernen</button>
          </div>` : ''}
          <div style="display:flex;gap:6px">
            <button class="btn" data-action="rc-edit-save" data-id="${r.id}" data-gid="${ev.id}" style="flex:1">\u2713 Speichern</button>
            <button class="btn" data-action="ev-cancel" style="flex:0;padding:7px 12px">\u2715</button>
          </div>
        </div>`;
        return;
      }
      const start = fmtStart(r.startTime);
      html += `<div class="ev-race">
        <div class="sl-dot" style="background:${statusColor(r)}"></div>
        <div style="flex:1;min-width:0">
          <div class="ev-rname">${escH(r.name)}</div>
          <div class="ev-meta">${r.riderCount} Fahrer${start ? ' \u00B7 ' + start : ''}${
            r.hasGpx ? ' \u00B7 \u{1F5FA} ' + escH(r.gpxName || 'Strecke') : ''}${
            r.status === 'beendet' ? ' \u00B7 beendet' : ''}</div>
        </div>
        ${r.category ? `<span class="ev-ak">${escH(r.category)}</span>` : ''}
        <button class="btn" data-action="rc-import" data-id="${r.id}"
          style="flex:0;padding:4px 8px;font-size:12px" title="Startliste importieren">\u{1F4C2}</button>
        <button class="btn" data-action="rc-gpx" data-id="${r.id}"
          style="flex:0;padding:4px 8px;font-size:12px${r.hasGpx ? ';color:#e65100' : ''}"
          title="Strecke laden">\u{1F5FA}</button>
        <button class="btn" data-action="rc-edit" data-id="${r.id}"
          style="flex:0;padding:4px 8px;font-size:12px">\u270E</button>
        ${r.isActive
          ? `<span style="font-size:11px;color:#2e7d32;font-weight:500;flex-shrink:0">aktiv</span>`
          : `<button class="btn" data-action="rc-activate" data-id="${r.id}"
               style="flex:0;padding:4px 8px;font-size:11px">Aktiv</button>`}
        <button class="btn" data-action="rc-del" data-id="${r.id}"
          style="flex:0;padding:4px 8px;font-size:12px;color:#f44336">\u2715</button>
      </div>`;
    });

    if (raceFormEvId === ev.id) {
      html += `<div class="ev-form">
        <input type="text" id="rcNewName" placeholder="Name des Rennens, z.B. Stra\u00DFenrennen">
        <div class="row">
          <input type="text" id="rcNewAk"    placeholder="AK, z.B. U17m">
          <input type="text" id="rcNewStart" placeholder="Start hh:mm">
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn" data-action="rc-new-save" data-id="${ev.id}" style="flex:1">\u2713 Anlegen</button>
          <button class="btn" data-action="ev-cancel" style="flex:0;padding:7px 12px">\u2715</button>
        </div>
      </div>`;
    } else {
      html += `<div style="padding:9px 14px">
        <button class="btn" data-action="rc-new" data-id="${ev.id}" style="width:100%;font-size:12px">\uFF0B Rennen</button>
      </div>`;
    }

    html += `</div>`;
  });

  if (evFormOpen) {
    html += `<div class="ev-card"><div class="ev-form">
      <input type="text" id="evNewName" placeholder="Name der Veranstaltung">
      <input type="text" id="evNewOrt"  placeholder="Ort">
      <div class="row">
        <input type="date" id="evNewFrom">
        <input type="date" id="evNewTo">
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn" data-action="ev-new-save" style="flex:1">\u2713 Anlegen</button>
        <button class="btn" data-action="ev-cancel" style="flex:0;padding:7px 12px">\u2715</button>
      </div>
    </div></div>`;
  } else {
    html += `<button class="btn" data-action="ev-new" style="width:100%">\uFF0B Veranstaltung</button>`;
  }

  html += `<div style="padding:14px 4px;font-size:11px;color:#aaa;line-height:1.5">
    Ablauf: Veranstaltung anlegen, Rennen mit AK darin anlegen, Startliste
    importieren, Strecke \u{1F5FA} laden, dann das Rennen aktiv schalten.
    Startliste, Strecke und Taktik-Stand geh\u00F6ren zum Rennen \u2013 beim
    Wechsel bleiben sie beim alten Rennen gespeichert.
  </div>`;

  evBody.innerHTML = html;
}

// =======================
// AKTIONEN
// =======================
async function guard(fn) {
  try { await fn(); }
  catch (err) { alert('\u274C ' + err.message); }
  renderEventsBody();
}

evBody.addEventListener('click', function (e) {
  if (!authToken) return;
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;

  switch (action) {
    case 'ev-new':
      resetEventForms(); evFormOpen = true; renderEventsBody();
      setTimeout(() => { const el = evBody.querySelector('#evNewName'); if (el) el.focus(); }, 30);
      break;

    case 'ev-cancel':
      resetEventForms(); renderEventsBody();
      break;

    case 'ev-new-save': {
      const name = val('#evNewName');
      if (!name) { const el = evBody.querySelector('#evNewName'); if (el) el.focus(); return; }
      const payload = { name, ort: val('#evNewOrt'), dateFrom: val('#evNewFrom') || null, dateTo: val('#evNewTo') || null };
      guard(async () => { await createEvent(payload); resetEventForms(); });
      break;
    }

    case 'ev-edit':
      resetEventForms(); evEditId = id; renderEventsBody();
      break;

    case 'ev-edit-save': {
      const name = val('#evEditName');
      if (!name) { const el = evBody.querySelector('#evEditName'); if (el) el.focus(); return; }
      const payload = { name, ort: val('#evEditOrt'), dateFrom: val('#evEditFrom') || null, dateTo: val('#evEditTo') || null };
      guard(async () => { await updateEvent(id, payload); resetEventForms(); });
      break;
    }

    case 'ev-del': {
      const ev = eventList.find(x => x.id === id);
      if (!ev) return;
      const n = (ev.races || []).length;
      const txt = n > 0
        ? `Veranstaltung \u201E${ev.name}\u201C mit ${n} Rennen l\u00F6schen?\nStartlisten und Abstandsverlauf gehen mit verloren.`
        : `Veranstaltung \u201E${ev.name}\u201C l\u00F6schen?`;
      if (!confirm(txt)) return;
      guard(async () => { await deleteEvent(id); resetEventForms(); });
      break;
    }

    case 'rc-new':
      resetEventForms(); raceFormEvId = id; renderEventsBody();
      setTimeout(() => { const el = evBody.querySelector('#rcNewName'); if (el) el.focus(); }, 30);
      break;

    case 'rc-new-save': {
      const name = val('#rcNewName');
      if (!name) { const el = evBody.querySelector('#rcNewName'); if (el) el.focus(); return; }
      const ev  = eventList.find(x => x.id === id);
      const day = ev ? (ev.dateFrom || ev.dateTo) : null;
      const payload = {
        eventId:   id,
        name,
        category:  val('#rcNewAk'),
        startTime: startTimeToIso(val('#rcNewStart'), day)
      };
      guard(async () => { await createRace(payload); resetEventForms(); raceFormEvId = id; });
      break;
    }

    case 'rc-edit':
      resetEventForms(); raceEditId = id; renderEventsBody();
      break;

    case 'rc-edit-save': {
      const name = val('#rcEditName');
      if (!name) { const el = evBody.querySelector('#rcEditName'); if (el) el.focus(); return; }
      const ev  = eventList.find(x => x.id === btn.dataset.gid);
      const day = ev ? (ev.dateFrom || ev.dateTo) : null;
      const payload = {
        name,
        category:  val('#rcEditAk'),
        startTime: startTimeToIso(val('#rcEditStart'), day)
      };
      guard(async () => { await updateRace(id, payload); resetEventForms(); });
      break;
    }

    case 'rc-activate':
      // Der Taktik-Stand wechselt mit: Gruppen des neuen Rennens laden.
      guard(async () => {
        await activateRaceById(id);
        await loadGroups();
        renderStrip(taktikGroups);
        await fetchGpxTrack();   // Strecke des neuen Rennens auf die Karte
      });
      break;

    case 'rc-import':
      openAiImport(id);
      break;

    case 'rc-gpx':
      // Oeffnet den Dateidialog; der Rest laeuft im change-Handler
      // von map/gpx.js und ruft danach renderEventsBody().
      pickGpxForRace(id);
      break;

    case 'rc-gpx-del': {
      const r = findRace(id);
      if (!r) return;
      if (!confirm(`Strecke \u201E${r.gpxName || 'Strecke'}\u201C von \u201E${r.name}\u201C entfernen?`)) return;
      guard(async () => { await removeGpxForRace(id); resetEventForms(); });
      break;
    }

    case 'rc-del': {
      const r = findRace(id);
      if (!r) return;
      if (!confirm(`Rennen \u201E${r.name}\u201C mit ${r.riderCount} Fahrern l\u00F6schen?`)) return;
      guard(async () => {
        await deleteRace(id);
        if (r.isActive) { await loadGroups(); renderStrip(taktikGroups); clearGpxLayer(); }
        resetEventForms();
      });
      break;
    }
  }
});

evBody.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter') return;
  const map = {
    evNewName:  '[data-action="ev-new-save"]',
    evNewOrt:   '[data-action="ev-new-save"]',
    evEditName: '[data-action="ev-edit-save"]',
    evEditOrt:  '[data-action="ev-edit-save"]',
    rcNewName:  '[data-action="rc-new-save"]',
    rcNewAk:    '[data-action="rc-new-save"]',
    rcNewStart: '[data-action="rc-new-save"]',
    rcEditName: '[data-action="rc-edit-save"]',
    rcEditAk:   '[data-action="rc-edit-save"]',
    rcEditStart:'[data-action="rc-edit-save"]'
  };
  const sel = map[e.target.id];
  if (!sel) return;
  e.preventDefault();
  const btn = evBody.querySelector(sel);
  if (btn) btn.click();
});
