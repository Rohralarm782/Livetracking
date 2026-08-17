// =======================
// FAVORITEN (eigene Fahrer)
// =======================
// Die Markierung haengt an der Startliste des Rennens, nicht an den
// Gruppen: sie soll einen Gruppenwechsel und ein Aufteilen ueberleben.
// Der Server schreibt sie nach races.riders_json und rettet sie ueber
// einen Re-Import.
//
// Zwei Wege fuehren hierher:
//   - dieses Modal, ueber die komplette Startliste, auch vor dem Start
//   - der Stern in der Fahrerzeile der Gruppenkarte, waehrend des Rennens
// Beide rufen dieselbe toggleFav() in race/taktik.js.
//
// Ladereihenfolge: nach race/events.js (loadActiveRiders, activeRaceId)
// und nach race/taktik.js (toggleFav).

let favModalOpen = false;
let favRiders    = [];
let favFilter    = '';
// Bearbeitungsmodus: gleiche Liste, zusaetzlich Aendern und Loeschen.
// Bewusst nicht dauerhaft an - waehrend des Rennens will man den
// Stern treffen und nicht den Papierkorb.
let favEditMode  = false;
let favEditNr    = null;

const favModal = document.getElementById('favModal');
const favBody  = document.getElementById('favBody');

async function openFavModal() {
  if (!activeRaceId) { alert('\u274C Kein Rennen aktiv \u2013 erst ein Rennen aktivieren'); return; }
  favModalOpen = true;
  favFilter    = '';
  favEditMode  = false;
  favEditNr    = null;
  applyFavEditMode();
  document.getElementById('favFilter').value = '';
  favModal.classList.remove('hidden');
  favBody.innerHTML = `<div class="fav-empty">\u23F3 Startliste wird geladen\u2026</div>`;
  favRiders = await loadActiveRiders();
  renderFavModal();
}

function closeFavModal() {
  favModalOpen = false;
  favModal.classList.add('hidden');
}

// Kein await noetig, wenn favRiders schon stehen - toggleFav() ruft
// die Funktion aber auch nach einem Serverlauf, deshalb async.
async function renderFavModal() {
  if (!favModalOpen) return;
  favRiders = await loadActiveRiders();

  const q = favFilter.trim().toLowerCase();
  const list = favRiders.filter(r => {
    if (!q) return true;
    return String(r.nr || '').includes(q)
        || String(r.name || '').toLowerCase().includes(q)
        || String(r.team || '').toLowerCase().includes(q);
  });

  // Favoriten nach oben: beim Nachkontrollieren waehrend des Rennens
  // will man sehen, wer markiert ist, nicht danach suchen.
  list.sort((a, b) => {
    if (!!a.fav !== !!b.fav) return a.fav ? -1 : 1;
    return (Number(a.nr) || 9999) - (Number(b.nr) || 9999);
  });

  const cnt = favRiders.filter(r => r && r.fav).length;
  document.getElementById('favCount').textContent =
    cnt === 0 ? 'Noch keine Favoriten' : `${cnt} markiert`;

  if (list.length === 0) {
    favBody.innerHTML = `<div class="fav-empty">${
      favRiders.length === 0
        ? 'Das aktive Rennen hat noch keine Startliste'
        : 'Kein Treffer'}</div>`;
    return;
  }

  favBody.innerHTML = list.map(r => {
    const nr  = r.nr === undefined || r.nr === null ? '' : r.nr;
    const on  = !!r.fav;

    // Zeile im Aenderungsmodus: Nummer, Name und Team direkt tippen.
    if (favEditMode && favEditNr !== null && String(favEditNr) === String(nr)) {
      return `<div class="fav-row" style="flex-wrap:wrap;gap:6px">
        <div class="row" style="width:100%">
          <input type="number" class="fav-e-nr" value="${escH(nr)}" min="1" style="flex:0 0 70px">
          <input type="text" class="fav-e-name" value="${escH(r.name || '')}" placeholder="Name">
        </div>
        <div class="row" style="width:100%">
          <input type="text" class="fav-e-team" value="${escH(r.team || '')}" placeholder="Team">
          <button class="btn fav-save"   data-nr="${nr}" style="flex:0 0 auto">\u2713</button>
          <button class="btn fav-cancel" style="flex:0 0 auto">\u2715</button>
        </div>
      </div>`;
    }

    // Ohne Startnummer laesst sich der Fahrer nicht adressieren -
    // die Anzeige auf dem Garmin kennt nur Nummern.
    const dis   = nr === '' ? ' disabled title="Ohne Startnummer nicht markierbar"' : '';
    const stDef = r.status ? RIDER_STATE_LABEL[r.status] : null;
    const badge = stDef
      ? `<span title="${stDef.title}" style="flex-shrink:0;font-size:10px;font-weight:600;padding:1px 5px;
           border-radius:5px;background:${stDef.bg};color:${stDef.fg};border:1px solid ${stDef.bd}">${stDef.txt}</span>`
      : '';
    const tools = (favEditMode && nr !== '')
      ? `<button class="btn fav-edit" data-nr="${nr}" title="\u00C4ndern" style="flex:0 0 auto;padding:3px 7px;font-size:12px">\u270E</button>
         <button class="btn fav-del"  data-nr="${nr}" title="Aus der Startliste nehmen" style="flex:0 0 auto;padding:3px 7px;font-size:12px;color:#f44336">\u{1F5D1}</button>`
      : '';
    return `<div class="fav-row${on ? ' on' : ''}">
      <button class="fav-star" data-nr="${nr}" data-on="${on ? '0' : '1'}"${dis}>${on ? '\u2605' : '\u2606'}</button>
      <span class="r-nr">${nr === '' ? '\u2013' : nr}</span>
      <div style="flex:1;min-width:0">
        <div class="r-name">${escH(r.name || '')}</div>
        <div class="r-team">${escH(r.team || '')}</div>
      </div>
      ${badge}
      ${tools}
    </div>`;
  }).join('');
}

// Sichtbarkeit der Bedienelemente an den Modus koppeln.
function applyFavEditMode() {
  const btn = document.getElementById('favEditToggle');
  const add = document.getElementById('favAddRow');
  btn.textContent = favEditMode ? '\u2713 Bearbeiten beenden' : '\u270E Startliste bearbeiten';
  btn.classList.toggle('active', favEditMode);
  add.classList.toggle('hidden', !favEditMode);
  document.getElementById('favAddError').textContent = '';
}

// Fahrer ergaenzen. Haeufigster Fall: der Import hat einen
// Nachmelder nicht erfasst.
async function addFavRider() {
  const errEl = document.getElementById('favAddError');
  const nr    = parseInt(document.getElementById('favNewNr').value);
  const name  = document.getElementById('favNewName').value.trim();
  const team  = document.getElementById('favNewTeam').value.trim();
  if (isNaN(nr) || nr < 1) { errEl.textContent = '\u274C Startnummer fehlt'; return; }
  if (!name)               { errEl.textContent = '\u274C Name fehlt'; return; }
  if (favRiders.some(r => r && Number(r.nr) === nr)) {
    errEl.textContent = `\u274C Nr. ${nr} ist schon vergeben`; return;
  }
  try {
    await saveRider(activeRaceId, { nr, name, team });
  } catch (err) { errEl.textContent = '\u274C ' + err.message; return; }
  errEl.textContent = '';
  document.getElementById('favNewNr').value   = '';
  document.getElementById('favNewName').value = '';
  document.getElementById('favNewTeam').value = '';
  await loadGroups();
  await renderFavModal();
  renderTaktikBody();
  document.getElementById('favNewNr').focus();
}

favBody.addEventListener('click', async function (e) {
  const star = e.target.closest('.fav-star');
  if (star && !star.disabled) {
    const nr = parseInt(star.dataset.nr);
    if (!isNaN(nr)) toggleFav(nr, star.dataset.on === '1');
    return;
  }

  const edit = e.target.closest('.fav-edit');
  if (edit) { favEditNr = parseInt(edit.dataset.nr); renderFavModal(); return; }

  const cancel = e.target.closest('.fav-cancel');
  if (cancel) { favEditNr = null; renderFavModal(); return; }

  const save = e.target.closest('.fav-save');
  if (save) {
    const row   = save.closest('.fav-row');
    const nr    = parseInt(save.dataset.nr);
    const newNr = parseInt(row.querySelector('.fav-e-nr').value);
    const name  = row.querySelector('.fav-e-name').value.trim();
    const team  = row.querySelector('.fav-e-team').value.trim();
    if (isNaN(newNr) || newNr < 1) { alert('\u274C Startnummer ungueltig'); return; }
    if (!name) { alert('\u274C Name fehlt'); return; }
    try {
      await saveRider(activeRaceId, { nr, newNr, name, team });
    } catch (err) { alert('\u274C ' + err.message); return; }
    favEditNr = null;
    await loadGroups();
    await renderFavModal();
    renderTaktikBody();
    return;
  }

  const del = e.target.closest('.fav-del');
  if (del) {
    const nr = parseInt(del.dataset.nr);
    const r  = favRiders.find(x => x && Number(x.nr) === nr);
    if (!confirm(`Nr. ${nr} ${r ? r.name : ''} aus der Startliste nehmen?`)) return;
    try {
      await deleteRiderFromRace(activeRaceId, nr);
    } catch (err) { alert('\u274C ' + err.message); return; }
    await loadGroups();
    await renderFavModal();
    renderTaktikBody();
    renderStrip(taktikGroups);
  }
});

document.getElementById('favEditToggle').addEventListener('click', () => {
  favEditMode = !favEditMode;
  favEditNr   = null;
  applyFavEditMode();
  renderFavModal();
});

document.getElementById('favAddBtn').addEventListener('click', addFavRider);

['favNewNr', 'favNewName', 'favNewTeam'].forEach(id => {
  document.getElementById(id).addEventListener('keypress', e => {
    if (e.key === 'Enter') { e.preventDefault(); addFavRider(); }
  });
});

document.getElementById('favFilter').addEventListener('input', function () {
  favFilter = this.value;
  renderFavModal();
});

document.getElementById('favCloseBtn').addEventListener('click', closeFavModal);
