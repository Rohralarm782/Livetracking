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

const favModal = document.getElementById('favModal');
const favBody  = document.getElementById('favBody');

async function openFavModal() {
  if (!activeRaceId) { alert('\u274C Kein Rennen aktiv \u2013 erst ein Rennen aktivieren'); return; }
  favModalOpen = true;
  favFilter    = '';
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
    // Ohne Startnummer laesst sich der Fahrer nicht adressieren -
    // die Anzeige auf dem Garmin kennt nur Nummern.
    const dis = nr === '' ? ' disabled title="Ohne Startnummer nicht markierbar"' : '';
    return `<div class="fav-row${on ? ' on' : ''}">
      <button class="fav-star" data-nr="${nr}" data-on="${on ? '0' : '1'}"${dis}>${on ? '\u2605' : '\u2606'}</button>
      <span class="r-nr">${nr === '' ? '\u2013' : nr}</span>
      <div style="flex:1;min-width:0">
        <div class="r-name">${escH(r.name || '')}</div>
        <div class="r-team">${escH(r.team || '')}</div>
      </div>
    </div>`;
  }).join('');
}

favBody.addEventListener('click', function (e) {
  const btn = e.target.closest('.fav-star');
  if (!btn || btn.disabled) return;
  const nr = parseInt(btn.dataset.nr);
  if (isNaN(nr)) return;
  toggleFav(nr, btn.dataset.on === '1');
});

document.getElementById('favFilter').addEventListener('input', function () {
  favFilter = this.value;
  renderFavModal();
});

document.getElementById('favCloseBtn').addEventListener('click', closeFavModal);
