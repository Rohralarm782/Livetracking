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
let zielRaceForm = null;    // Rennen, dessen Start/Ziel gerade gesetzt wird
// Formular fuer einen Streckenpunkt. id === null heisst: neu anlegen.
let mkForm = null;          // { raceId, id, typ }

function resetEventForms() {
  evFormOpen = false; evEditId = null; raceFormEvId = null; raceEditId = null;
  zielRaceForm = null; mkForm = null;
}

async function openEventsPanel() {
  // Ab 2.5.0 ist die Rennverwaltung SpoLei-Sache. Der Knopf ist fuer
  // andere Rollen ausgeblendet; dieser Riegel faengt jeden Weg ab, der
  // nicht ueber den Knopf laeuft. Der Server weist die Aufrufe ohnehin
  // ab - hier geht es darum, dass die Ansicht gar nicht erst aufgeht.
  if (authLevel !== 'spolei') return;
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
        <button class="btn" data-action="open-timing" data-id="${ev.id}"
          style="flex:0;padding:4px 8px;font-size:12px${
            (timingCfg.ev && timingCfg.ev[ev.id]) ? ';color:#5e35b1;border-color:#b39ddb' : ''}"
          title="Zeitmessung verbinden">\u23F1</button>
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
        <div class="sl-dot" style="background:${r.color || statusColor(r)}"
             title="${r.color ? 'Farbe dieses Rennens auf der Karte' : ''}"></div>
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
        <button class="btn" data-action="rc-copy" data-id="${r.id}"
          style="flex:0;padding:4px 8px;font-size:12px" title="Rennen kopieren (gleiche Startliste)">\u29C9</button>
        ${r.hasGpx
          ? `<button class="btn" data-action="rc-ziel" data-id="${r.id}"
               style="flex:0;padding:4px 8px;font-size:12px${
                 zielRaceForm === r.id ? ';color:#1565c0' : ''}"
               title="Start/Ziel festlegen">\u{1F4D0}</button>`
          : ''}
        <button class="btn" data-action="rc-laps" data-id="${r.id}"
          style="flex:0;padding:4px 8px;font-size:11px"
          title="Sollrunden festlegen">\u{1F501}${r.laps ? ' ' + r.currentLap + '/' + r.laps : ''}</button>
        <button class="btn" data-action="rc-csv" data-id="${r.id}"
          style="flex:0;padding:4px 8px;font-size:12px"
          title="Rennprotokoll als CSV">\u{1F4CA}</button>
        ${r.isActive
          ? `<button class="btn" data-action="rc-start" data-id="${r.id}"
               style="flex:0;padding:4px 8px;font-size:11px${r.actualStart ? ';color:#2e7d32' : ''}"
               title="${r.actualStart ? 'Startschuss zur\u00FCcknehmen' : 'Startschuss jetzt festhalten'}"
             >\u{1F3C1}${r.actualStart ? ' l\u00E4uft' : ' Start'}</button>`
          : ''}
        <button class="btn" data-action="rc-edit" data-id="${r.id}"
          style="flex:0;padding:4px 8px;font-size:12px">\u270E</button>
        ${r.isActive
          ? `<button class="btn" data-action="rc-deactivate" data-id="${r.id}"
               style="flex:0;padding:4px 8px;font-size:11px;color:#2e7d32;border-color:#4caf50"
               title="Rennen beenden \u2013 danach ist kein Rennen aktiv"
             >aktiv \u2715</button>`
          : `<button class="btn" data-action="rc-activate" data-id="${r.id}"
               style="flex:0;padding:4px 8px;font-size:11px">Aktiv</button>`}
        <button class="btn" data-action="rc-del" data-id="${r.id}"
          style="flex:0;padding:4px 8px;font-size:12px;color:#f44336">\u2715</button>
      </div>`;

      // Zugeordnete Tracker. Nur sichtbar, wenn es welche gibt - im
      // Einzelrennen-Betrieb ordnet niemand zu, dann bleibt die Zeile
      // weg. Zugeordnet wird auf der Karte per Rechtsklick bzw. langem
      // Druck auf den Marker.
      if (Array.isArray(r.tracker) && r.tracker.length) {
        html += `<div class="ev-tracker">
          <span class="tPunkt" style="background:${r.color || '#90a4ae'}"></span>
          ${r.tracker.length} Tracker: ${escH(r.tracker.join(', '))}
        </div>`;
      }

      // Start/Ziel-Panel direkt unter der Rennzeile. Bewusst kein
      // Modal: der Zielstrich gehoert zur Vorbereitung des Rennens und
      // soll neben Startliste und Strecke stehen.
      if (zielRaceForm === r.id) {
        const km = ((r.startOffset || 0) / 1000).toFixed(2).replace('.', ',');
        html += `<div class="ev-ziel">
          <div class="zTitel">\u{1F4D0} Strecke \u2013 ${escH(r.name)}</div>
          <div class="zUnter">Start / Ziel</div>
          <div class="row">
            <input type="text" id="rcZielKm" inputmode="decimal" value="${km}"
                   aria-label="Kilometer vom Streckenanfang">
            <button class="btn" data-action="rc-ziel-km" data-id="${r.id}">\u2713 km</button>
          </div>
          <div class="zBtns">
            <button class="btn" data-action="rc-ziel-hier" data-id="${r.id}"
              title="Start/Ziel auf die aktuelle Position legen">\u{1F4CD} Hier</button>
            ${r.isActive
              ? `<button class="btn" data-action="rc-ziel-karte" data-id="${r.id}"
                   >\u{1F5FA} Auf Karte tippen</button>`
              : ''}
            <button class="btn" data-action="ev-cancel">\u2715</button>
          </div>
          <div class="zHint">Kilometer ab Anfang der GPX-Datei.${
            r.isActive ? '' : ' Auf der Karte tippen geht nur beim aktiven Rennen.'}</div>
          ${markerBlockHtml(r)}
        </div>`;
      }
    });

    if (raceFormEvId === ev.id) {
      html += `<div class="ev-form">
        <input type="text" id="rcNewName" placeholder="Name des Rennens, z.B. Stra\u00DFenrennen">
        <div class="row">
          <input type="text" id="rcNewAk"    placeholder="AK, z.B. U17m">
          <input type="text" id="rcNewStart" placeholder="Start hh:mm">
        </div>
        <input type="number" id="rcNewLaps" min="1" max="99"
               placeholder="Runden (leer = ohne Rundenz\u00E4hlung)">
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
    Wechsel bleiben sie beim alten Rennen gespeichert.<br><br>
    Tracker werden auf der Karte zugeordnet: langer Druck bzw. Rechtsklick
    auf den Marker. Ein zugeordneter Tracker tr\u00E4gt die Farbe seines
    Rennens und rechnet auf dessen Strecke. Beim Beenden eines Rennens
    werden seine Tracker wieder frei.
  </div>`;

  evBody.innerHTML = html;
}

// =======================
// STRECKENPUNKTE
// =======================
// Fuenf Arten. Verpflegung und freie Punkte duerfen eine Ausdehnung
// haben - eine Verpflegungszone ist im Reglement 100 bis 200 m lang.
const MK_ARTEN = [
  { typ: 'wertung',     icon: '\u{1F3C5}', label: 'Sprint',      zone: false },
  { typ: 'berg',        icon: '\u26F0\uFE0F', label: 'Berg',     zone: false },
  { typ: 'verpflegung', icon: '\u{1F34C}', label: 'Verpflegung', zone: true  },
  { typ: 'start',       icon: '\u{1F6A9}', label: 'Start',       zone: false },
  { typ: 'frei',        icon: '\u{1F4CC}', label: 'Frei',        zone: true  },
  // Ans Ende, nicht dazwischen: mkArt() faellt unten auf MK_ARTEN[4]
  // zurueck. Ein Einschub weiter oben wuerde jeden unbekannten Typ als
  // Zwischenzeit anzeigen.
  { typ: 'zwischenzeit', icon: '\u23F1\uFE0F', label: 'ZZ',       zone: false }
];

function mkArt(typ) { return MK_ARTEN.find(a => a.typ === typ) || MK_ARTEN[4]; }
function mkKm(meter) { return ((meter || 0) / 1000).toFixed(2).replace('.', ','); }

function markerBlockHtml(r) {
  const liste = Array.isArray(r.marker) ? r.marker : [];
  let h = `<div class="zUnter">Punkte auf der Strecke</div>`;

  if (!liste.length && !(mkForm && mkForm.raceId === r.id)) {
    h += `<div class="zHint" style="margin-top:0">Noch keine \u2013 Sprint, Bergwertung
          oder Verpflegungszone lassen sich hier eintragen.</div>`;
  }

  liste.forEach(m => {
    const a = mkArt(m.typ);
    const bereich = (m.sEnde !== undefined && m.sEnde !== null)
      ? ` \u2013 ${mkKm(m.sEnde)}` : '';
    const runden = (Array.isArray(m.runden) && m.runden.length)
      ? ` \u00B7 Runde ${m.runden.join(', ')}` : '';
    h += `<div class="mk-zeile">
      <span class="mk-icon">${a.icon}</span>
      <div style="flex:1;min-width:0">
        <div class="mk-name">${escH(m.name || a.label)}</div>
        <div class="mk-meta">km ${mkKm(m.s)}${bereich}${runden}</div>
      </div>
      <button class="btn" data-action="mk-edit" data-id="${r.id}" data-mid="${m.id}"
        style="padding:4px 8px;font-size:12px">\u270E</button>
      <button class="btn" data-action="mk-del" data-id="${r.id}" data-mid="${m.id}"
        style="padding:4px 8px;font-size:12px;color:#f44336">\u2715</button>
    </div>`;
  });

  if (mkForm && mkForm.raceId === r.id) {
    const m = mkForm.id ? liste.find(x => x.id === mkForm.id) : null;
    const a = mkArt(mkForm.typ);
    h += `<div class="mk-form">
      <div class="mk-typen">
        ${MK_ARTEN.map(x => `<button class="btn ${x.typ === mkForm.typ ? 'active' : ''}"
            data-action="mk-typ" data-id="${r.id}" data-typ="${x.typ}"
            style="padding:5px 9px;font-size:12px">${x.icon} ${x.label}</button>`).join('')}
      </div>
      <input type="text" id="mkName" maxlength="30" value="${escH(m && m.name ? m.name : '')}"
             placeholder="Name, z.\u202FB. Bergpreis Ilsenburg">
      <div class="row">
        <input type="text" id="mkKm" inputmode="decimal" value="${m ? mkKm(m.s) : ''}"
               placeholder="km" aria-label="Kilometer">
        <button class="btn" data-action="mk-hier" data-id="${r.id}"
          title="aktuelle Position \u00FCbernehmen">\u{1F4CD}</button>
      </div>
      ${a.zone ? `<div class="row">
        <input type="text" id="mkKmEnde" inputmode="decimal"
               value="${m && m.sEnde !== undefined && m.sEnde !== null ? mkKm(m.sEnde) : ''}"
               placeholder="Ende km (leer = Punkt statt Zone)" aria-label="Ende in Kilometern">
      </div>` : ''}
      <input type="text" id="mkRunden"
             value="${m && Array.isArray(m.runden) ? m.runden.join(', ') : ''}"
             placeholder="Runden, z.\u202FB. 2, 4 \u2013 leer = jede Runde">
      <div class="zBtns">
        <button class="btn" data-action="mk-save" data-id="${r.id}">\u2713 Speichern</button>
        ${(mkForm.id && r.isActive)
          ? `<button class="btn" data-action="mk-karte" data-id="${r.id}" data-mid="${mkForm.id}"
               >\u{1F5FA} Auf Karte tippen</button>`
          : ''}
        <button class="btn" data-action="mk-abbruch" data-id="${r.id}">\u2715</button>
      </div>
    </div>`;
  } else {
    h += `<div class="zBtns" style="margin-top:8px">
      <button class="btn" data-action="mk-neu" data-id="${r.id}">\uFF0B Punkt</button>
    </div>`;
  }
  return h;
}

// km-Feld -> Meter. null heisst "leer gelassen", das ist bei der
// Zonenlaenge ein gueltiger Wert.
function mkMeter(sel) {
  const roh = val(sel);
  if (roh === '') return null;
  const v = parseFloat(roh.replace(',', '.'));
  return (isNaN(v) || v < 0) ? undefined : Math.round(v * 1000);
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
      const runden = parseInt(val('#rcNewLaps'));
      guard(async () => {
        // createRace liefert die ID als String zurueck, kein Objekt.
        const neuId = await createRace(payload);
        // Runden gehen ueber einen eigenen Endpoint: sie liegen in
        // raceMeta, nicht im Rennobjekt selbst.
        if (runden > 0 && neuId) await setRaceLaps(neuId, { laps: runden });
        resetEventForms(); raceFormEvId = id;
      });
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

    case 'rc-laps': {
      const rr = findRace(id);
      const jetzt = rr && rr.laps ? String(rr.laps) : '';
      const ein = prompt('Zu fahrende Runden (leer = ohne Rundenz\u00E4hlung):', jetzt);
      if (ein === null) break;
      const n = parseInt(ein);
      guard(async () => {
        await setRaceLaps(id, { laps: (ein.trim() === '' ? null : (n > 0 ? n : 1)) });
        await loadEvents(); renderEventsBody();
        showToast(ein.trim() === '' ? '\u{1F501} Rundenz\u00E4hlung aus' : `\u{1F501} ${n} Runden`);
      });
      break;
    }

    case 'rc-ziel': {
      // Panel auf/zu. Andere Formulare schliessen, damit nie zwei
      // Eingaben gleichzeitig offen stehen.
      const offen = zielRaceForm === id;
      resetEventForms();
      zielRaceForm = offen ? null : id;
      renderEventsBody();
      if (!offen) setTimeout(() => {
        const el = evBody.querySelector('#rcZielKm');
        if (el) { el.focus(); el.select(); }
      }, 30);
      break;
    }

    case 'rc-ziel-km': {
      const v = parseFloat(String(val('#rcZielKm')).replace(',', '.'));
      if (isNaN(v) || v < 0) { showToast('\u26A0\uFE0F Bitte Kilometer eingeben, z.\u202FB. 4,20'); break; }
      // loadEvents() danach: sonst zeigt das Feld beim naechsten
      // Rendern wieder den alten Wert aus der Rennliste.
      guard(async () => {
        if (await sendeZiel({ startOffset: Math.round(v * 1000) }, id)) await loadEvents();
      });
      break;
    }

    case 'rc-ziel-hier': {
      if (!navigator.geolocation) { showToast('\u26A0\uFE0F Kein GPS verf\u00FCgbar'); break; }
      showToast('\u{1F4CD} Position wird bestimmt\u2026');
      navigator.geolocation.getCurrentPosition(
        p => guard(async () => {
          if (await sendeZiel({ atLat: p.coords.latitude, atLon: p.coords.longitude }, id)) await loadEvents();
        }),
        () => showToast('\u26A0\uFE0F Position nicht ermittelbar'),
        { enableHighAccuracy: true, timeout: 10000 }
      );
      break;
    }

    case 'mk-neu':
      mkForm = { raceId: id, id: null, typ: 'wertung' };
      renderEventsBody();
      setTimeout(() => { const el = evBody.querySelector('#mkKm'); if (el) el.focus(); }, 30);
      break;

    case 'mk-typ':
      if (mkForm) { mkForm.typ = btn.dataset.typ; renderEventsBody(); }
      break;

    case 'mk-edit': {
      const rr = findRace(id);
      const m  = rr && Array.isArray(rr.marker) ? rr.marker.find(x => x.id === btn.dataset.mid) : null;
      if (!m) break;
      mkForm = { raceId: id, id: m.id, typ: m.typ };
      renderEventsBody();
      break;
    }

    case 'mk-abbruch':
      mkForm = null;
      renderEventsBody();
      break;

    case 'mk-save': {
      if (!mkForm) break;
      const s = mkMeter('#mkKm');
      if (s === undefined) { showToast('\u26A0\uFE0F Bitte Kilometer eingeben, z.\u202FB. 3,40'); break; }
      if (s === null && !mkForm.id) { showToast('\u26A0\uFE0F Ohne Kilometer geht es nicht'); break; }
      const felder = { typ: mkForm.typ, name: val('#mkName'), runden: val('#mkRunden') };
      if (mkForm.id) felder.id = mkForm.id;
      if (s !== null) felder.s = s;
      if (mkArt(mkForm.typ).zone) {
        const e = mkMeter('#mkKmEnde');
        if (e === undefined) { showToast('\u26A0\uFE0F Ende bitte als Kilometer, z.\u202FB. 3,60'); break; }
        felder.sEnde = e;   // null loescht die Ausdehnung
      }
      guard(async () => {
        const d = await saveMarker(id, felder);
        uebernehmeMarker(id, d.marker);
        await loadEvents();
        mkForm = null;
        showToast(`${mkArt(felder.typ).icon} Punkt gespeichert`);
      });
      break;
    }

    case 'mk-hier': {
      if (!navigator.geolocation) { showToast('\u26A0\uFE0F Kein GPS verf\u00FCgbar'); break; }
      showToast('\u{1F4CD} Position wird bestimmt\u2026');
      navigator.geolocation.getCurrentPosition(
        p => guard(async () => {
          if (!mkForm) return;
          const felder = { typ: mkForm.typ, name: val('#mkName'), runden: val('#mkRunden'),
                           atLat: p.coords.latitude, atLon: p.coords.longitude };
          if (mkForm.id) felder.id = mkForm.id;
          const d = await saveMarker(id, felder);
          uebernehmeMarker(id, d.marker);
          await loadEvents();
          // Formular offen lassen und auf den neuen Punkt umschalten:
          // Name und Runden will man meist gleich danach nachtragen.
          const neu = (d.marker || []).find(x => !mkForm.id ? true : x.id === mkForm.id);
          mkForm.id = mkForm.id || (neu ? neu.id : null);
          showToast('\u{1F4CD} Punkt auf die aktuelle Position gelegt');
        }),
        () => showToast('\u26A0\uFE0F Position nicht ermittelbar'),
        { enableHighAccuracy: true, timeout: 10000 }
      );
      break;
    }

    case 'mk-del': {
      const rr = findRace(id);
      const m  = rr && Array.isArray(rr.marker) ? rr.marker.find(x => x.id === btn.dataset.mid) : null;
      if (!m) break;
      if (!confirm(`\u201E${m.name || mkArt(m.typ).label}\u201C bei km ${mkKm(m.s)} entfernen?`)) break;
      guard(async () => {
        const d = await deleteMarker(id, m.id);
        uebernehmeMarker(id, d.marker);
        await loadEvents();
        mkForm = null;
      });
      break;
    }

    case 'mk-karte': {
      // Wie bei rc-ziel-karte: der Modus kennt sein Rennen, also
      // reicht die Strecke als Bedingung.
      const rr = findRace(id);
      if (!rr)        { showToast('\u26A0\uFE0F Rennen nicht gefunden'); break; }
      if (!rr.hasGpx) { showToast('\u26A0\uFE0F Rennen hat keine Strecke'); break; }
      zielRaceForm = null;
      mkForm = null;
      closeTaktikView();
      setStreckenModus(true, id, btn.dataset.mid);
      break;
    }

    case 'rc-ziel-karte': {
      // Ab 2.0 traegt der Modus die Renn-ID mit sich und zeigt nur
      // dessen Linie - damit ist auch ein noch nicht laufendes Rennen
      // gefahrlos zu bearbeiten. Vorher ging das nur beim aktiven,
      // weil auf der Karte immer nur eine Linie lag.
      const rz = findRace(id);
      if (!rz)         { showToast('\u26A0\uFE0F Rennen nicht gefunden'); break; }
      if (!rz.hasGpx)  { showToast('\u26A0\uFE0F Rennen hat keine Strecke'); break; }
      zielRaceForm = null;
      closeTaktikView();
      setStreckenModus(true, id);
      break;
    }

    case 'rc-csv': {
      // Als Blob holen statt per Link: der Endpoint verlangt einen
      // Token, den ein normales <a href> nicht mitschickt.
      guard(async () => {
        const res = await fetch(`${SERVER}/races/${id}/protocol.csv`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (!res.ok) {
          checkAuth(res);
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || `Protokoll nicht abrufbar (${res.status})`);
        }
        const blob = await res.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        const rr   = findRace(id);
        a.href = url;
        a.download = `Protokoll_${String(rr ? rr.name : id).replace(/[^\w\-]+/g, '_').slice(0, 40)}.csv`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      });
      break;
    }

    case 'rc-start': {
      const rr = findRace(id);
      const an = !(rr && rr.actualStart);
      if (!an && !confirm('Startschuss zur\u00FCcknehmen? Fahrtzeit und Schnitt beziehen sich danach wieder auf den geplanten Start.')) break;
      guard(async () => {
        // Reihenfolge der Argumente: apiSend(path, method, body).
        // Bis 1.12.1 stand hier apiSend('POST', ...) - fetch() warf
        // deshalb bei jedem Druck auf "Start" einen TypeError.
        await apiSend(`/races/${id}/start`, 'POST', { actual: an });
        await loadEvents();
        renderEventsBody();
        showToast(an ? '\u{1F3C1} Start festgehalten' : '\u{1F3C1} Start zur\u00FCckgenommen');
      });
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

    case 'rc-deactivate': {
      const rd = findRace(id);
      if (!rd) return;
      if (!confirm(`Rennen \u201E${rd.name}\u201C beenden?\nDanach ist kein Rennen aktiv. Gruppen und Strecke bleiben beim Rennen gespeichert.`)) return;
      guard(async () => {
        await deactivateRaceById(id);
        await loadGroups();
        renderStrip(taktikGroups);
        await fetchGpxTrack();   // raeumt die Strecke von der Karte
        resetEventForms();
      });
      break;
    }

    case 'rc-copy': {
      // Fuer Etappenrennen und zweite Laeufe: gleiche Startliste,
      // gleiche AK, keine Gruppen, keine Strecke.
      const r = findRace(id);
      if (!r) return;
      const name = prompt('Name des neuen Rennens:', r.name + ' (Kopie)');
      if (name === null) return;
      guard(async () => { await duplicateRace(id, name.trim() || undefined); resetEventForms(); });
      break;
    }

    case 'rc-import':
      openAiImport(id);
      break;

    case 'open-timing':
      openTimingSetup(id);
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
    rcEditStart:'[data-action="rc-edit-save"]',
    rcZielKm:   '[data-action="rc-ziel-km"]',
    mkName:     '[data-action="mk-save"]',
    mkKm:       '[data-action="mk-save"]',
    mkKmEnde:   '[data-action="mk-save"]',
    mkRunden:   '[data-action="mk-save"]'
  };
  const sel = map[e.target.id];
  if (!sel) return;
  e.preventDefault();
  const btn = evBody.querySelector(sel);
  if (btn) btn.click();
});
