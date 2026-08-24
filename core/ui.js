// =======================
// BETREUER
// =======================
let betreuerSharedName = '';

function showBetreuerShareModal() {
  closeOptionsMenu();
  document.getElementById('betreuerNameInput').value = betreuerSharedName;
  document.getElementById('betreuerError').textContent = '';
  document.getElementById('betreuerConfirmBtn').textContent = '\u{1F4CD} Jetzt teilen';
  document.getElementById('betreuerConfirmBtn').disabled = false;
  document.getElementById('betreuerModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('betreuerNameInput').focus(), 50);
}

async function confirmBetreuerShare() {
  const name    = document.getElementById('betreuerNameInput').value.trim();
  const errorEl = document.getElementById('betreuerError');
  if (!name) { errorEl.textContent = '\u274C Name erforderlich'; return; }
  const btn = document.getElementById('betreuerConfirmBtn');
  btn.textContent = '\u23F3 GPS wird abgerufen\u2026';
  btn.disabled    = true;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const res = await fetch(`${SERVER}/betreuer-position`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          body: JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude, name })
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Fehler'); }
        betreuerSharedName = name;
        document.getElementById('betreuerModal').classList.add('hidden');
        document.getElementById('betreuerBtn').textContent = '\u{1F504} Standort aktualisieren';
        errorEl.textContent = '';
      } catch (err) {
        errorEl.textContent = '\u274C ' + err.message;
        btn.textContent = '\u{1F4CD} Jetzt teilen';
        btn.disabled    = false;
      }
    },
    (err) => {
      errorEl.textContent = '\u274C GPS: ' + err.message;
      btn.textContent = '\u{1F4CD} Jetzt teilen';
      btn.disabled    = false;
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

document.getElementById('betreuerBtn').addEventListener('click', showBetreuerShareModal);
document.getElementById('betreuerConfirmBtn').addEventListener('click', confirmBetreuerShare);
document.getElementById('betreuerCancelBtn').addEventListener('click', () => {
  document.getElementById('betreuerModal').classList.add('hidden');
});
document.getElementById('betreuerNameInput').addEventListener('keypress', e => {
  if (e.key === 'Enter') confirmBetreuerShare();
});

// =======================
// MODUS (Toggle Switch)
// =======================
function applyMode(mode) {
  currentMode = mode;
  const label = document.getElementById('modeLabel');
  const sub   = document.getElementById('modeSub');
  const sw    = document.getElementById('modeSwitch');
  const thumb = document.getElementById('modeThumb');
  if (mode === 'race') {
    label.textContent   = 'Renn-Modus';
    sub.textContent     = '2s bewegend \u00B7 30s stehend';
    sw.style.background = '#2196F3';
    thumb.style.left    = '22px';
  } else {
    label.textContent   = 'Training-Modus';
    sub.textContent     = '10s bewegend \u00B7 60s stehend';
    sw.style.background = '#bbb';
    thumb.style.left    = '2px';
  }
}

async function loadMode() {
  try {
    const res  = await fetch(`${SERVER}/mode`);
    const data = await res.json();
    applyMode(data.mode);
  } catch (err) { console.error('Mode fetch:', err); }
}

document.getElementById('modeSwitch').addEventListener('click', async () => {
  if (!authToken) return;
  const newMode = currentMode === 'race' ? 'training' : 'race';
  try {
    const res  = await fetch(`${SERVER}/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ mode: newMode })
    });
    const data = await res.json();
    if (res.ok) applyMode(data.mode);
  } catch (err) { console.error('Mode switch:', err); }
});

// =======================
// VERSION
// =======================
// Die geladene Version. Weicht sie spaeter von der ab, die der Server
// meldet, laeuft hier ein veralteter Stand - typisch fuer ein Tablet,
// das seit dem Vortag offen ist.
let APP_VERSION = null;
let versionGemeldet = false;

async function loadVersion() {
  try {
    const res = await fetch(`${SERVER}/version`, { cache: 'no-store' });
    if (!res.ok) return;
    const d = await res.json();
    if (!d || typeof d.version !== 'string') return;
    APP_VERSION = d.version;
    const el = document.getElementById('versionInfo');
    if (el) {
      el.textContent = `Version ${d.version}`
        + (d.date ? ' \u00B7 ' + datumKurz(d.date) : '');
      if (d.title) el.title = d.title;
    }
  } catch (e) { /* ohne Netz bleibt die Anzeige leer */ }
}

function datumKurz(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso);
}

// Wird aus loadActiveInfo() gerufen, das ohnehin alle 20 Sekunden laeuft.
function pruefeVersion(serverVersion) {
  if (!serverVersion || !APP_VERSION) return;
  if (serverVersion === APP_VERSION || versionGemeldet) return;
  versionGemeldet = true;
  showToast(`\u{1F504} Neue Version ${serverVersion} \u2013 bitte neu laden`, 10000);
  const el = document.getElementById('versionInfo');
  if (el) {
    el.textContent = `Version ${APP_VERSION} \u2013 veraltet, ${serverVersion} verf\u00FCgbar`;
    el.classList.add('veraltet');
  }
}

// =======================
// OPTIONS MENU
// =======================
const optionsBtn  = document.getElementById('optionsBtn');
const optionsMenu = document.getElementById('optionsMenu');

const advancedModal = document.getElementById('advancedModal');

function openAdvanced() {
  optionsMenu.classList.add('hidden');
  advancedModal.classList.remove('hidden');
}

function closeAdvanced() {
  advancedModal.classList.add('hidden');
}

function closeOptionsMenu() {
  optionsMenu.classList.add('hidden');
}

optionsBtn.addEventListener('click', e => {
  e.stopPropagation();
  optionsMenu.classList.toggle('hidden');
});

document.addEventListener('click', e => {
  if (!optionsBtn.contains(e.target) && !optionsMenu.contains(e.target)
      && !document.getElementById('taktikBtn').contains(e.target)) {
    closeOptionsMenu();
  }
});

// Der Advanced-Knopf oeffnet ein eigenes Fenster und schliesst das Menue
// dabei selbst, deshalb ist er hier ausgenommen.
optionsMenu.querySelectorAll('#optionsMain .btn').forEach(btn => {
  if (btn.id !== 'advancedBtn' && btn.id !== 'betreuerBtn')
    btn.addEventListener('click', () => closeOptionsMenu());
});

document.getElementById('teamCarToggle').addEventListener('change', () => closeOptionsMenu());

// Der Streckenmodus wird seit 1.13.0 aus der Rennverwaltung heraus
// gestartet (race/events-ui.js, Aktion rc-ziel-karte). Hier bleibt nur
// das Beenden: die Leiste liegt ueber der Karte, nicht im Menue, und
// muss auch dann schliessbar sein, wenn die Taktikansicht zu ist.
document.getElementById('streckenFertig').addEventListener('click', () => setStreckenModus(false));

// Genaue Eingabe fuer die Vorbereitung am Rechner.
function streckenKmUebernehmen() {
  // Zweiter Riegel neben dem Ausblenden in beschrifteStreckenBar():
  // ein versehentlich verschobener Zielstrich verwirft mitten im
  // Rennen die Rundenzaehlung.
  if (typeof zielMarkerId !== 'undefined' && zielMarkerId) return;
  const el = document.getElementById('streckenKm');
  const v  = parseFloat(String(el.value).replace(',', '.'));
  if (isNaN(v) || v < 0) { showToast('\u26A0\uFE0F Bitte Kilometer eingeben, z.\u202FB. 4,20'); zeigeZielKm(); return; }
  sendeZiel({ startOffset: Math.round(v * 1000) });
}
document.getElementById('streckenKmOk').addEventListener('click', streckenKmUebernehmen);
document.getElementById('streckenKm').addEventListener('keydown', e => {
  if (e.key === 'Enter') streckenKmUebernehmen();
});

document.getElementById('advancedBtn').addEventListener('click', openAdvanced);
document.getElementById('advCloseX').addEventListener('click', closeAdvanced);
document.getElementById('advDoneBtn').addEventListener('click', closeAdvanced);
document.getElementById('advScrim').addEventListener('click', closeAdvanced);

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  // Liegt die Loesch-Rueckfrage oben drauf, gehoert ESC ihr allein.
  // Sie schliesst sich in map/map.js selbst, das Sheet bleibt stehen.
  const cc = document.getElementById('confirmClearModal');
  if (cc && !cc.classList.contains('hidden')) return;
  if (!advancedModal.classList.contains('hidden')) { closeAdvanced(); return; }
  if (streckenModus) { setStreckenModus(false); return; }
  if (!optionsMenu.classList.contains('hidden')) closeOptionsMenu();
});

// =======================
// WAKE LOCK
// =======================
// Der Bildschirm bleibt jetzt standardmaessig an. Wer im Teamwagen sitzt,
// will die Karte sehen und nicht alle 30 Sekunden das Handy antippen.
// Abschalten geht in den Erweiterten Einstellungen, die Wahl haelt.
let wakeLock       = null;
let wakeLockWanted = localStorage.getItem('wakeLockPref') !== 'off';
let wakeLockRetry  = false;

function updateWakeLockUi() {
  const sw  = document.getElementById('wakeLockSwitch');
  const sub = document.getElementById('wakeLockSub');
  if (!sw || !sub) return;
  sw.classList.toggle('on', wakeLockWanted);
  sub.textContent = wakeLockWanted
    ? 'Ist an. Das Display schaltet sich w\u00E4hrend des Rennens nicht ab.'
    : 'Ist aus. Das Display schaltet sich nach der Zeit deines Handys ab.';
}

// Manche Browser geben den Lock erst nach einer Nutzerinteraktion frei.
// Dann wird er beim ersten Tippen still nachgeholt, ohne Meldung.
function armWakeLockRetry() {
  if (wakeLockRetry) return;
  wakeLockRetry = true;
  document.addEventListener('pointerdown', () => {
    wakeLockRetry = false;
    acquireWakeLock();
  }, { once: true });
}

async function acquireWakeLock() {
  if (!wakeLockWanted || wakeLock) return;
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (err) {
    wakeLock = null;
    console.warn('Wake Lock noch nicht moeglich:', err.name);
    armWakeLockRetry();
  }
}

async function releaseWakeLock() {
  if (!wakeLock) return;
  try { await wakeLock.release(); } catch (err) { console.error('Wake Lock Release:', err); }
  wakeLock = null;
}

document.getElementById('wakeLockSwitch').addEventListener('click', () => {
  wakeLockWanted = !wakeLockWanted;
  localStorage.setItem('wakeLockPref', wakeLockWanted ? 'on' : 'off');
  updateWakeLockUi();
  if (wakeLockWanted) acquireWakeLock();
  else                releaseWakeLock();
});

updateWakeLockUi();
acquireWakeLock();

document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  // Beim Sperren gibt das System den Lock frei. Nach dem Entsperren
  // entscheidet die gespeicherte Wahl, nicht der alte Handle.
  acquireWakeLock();
  if (document.getElementById('teamCarCheckbox').checked) {
    stopTeamCarTracking();
    startTeamCarTracking();
    showToast('\u{1F4CD} Tracker neugestartet \u2713');
  }
});

