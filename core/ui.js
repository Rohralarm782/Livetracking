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
// OPTIONS MENU
// =======================
const optionsBtn  = document.getElementById('optionsBtn');
const optionsMenu = document.getElementById('optionsMenu');

function closeOptionsMenu() {
  optionsMenu.classList.add('hidden');
  document.getElementById('advancedSection').classList.add('hidden');
  document.getElementById('advancedBtn').textContent = '\u2699\uFE0F Erweiterte Einstellungen \u25B8';
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

optionsMenu.querySelectorAll('.btn').forEach(btn => {
  if (btn.id !== 'advancedBtn' && btn.id !== 'betreuerBtn')
    btn.addEventListener('click', () => closeOptionsMenu());
});

document.getElementById('teamCarToggle').addEventListener('change', () => closeOptionsMenu());

document.getElementById('advancedBtn').addEventListener('click', () => {
  const section = document.getElementById('advancedSection');
  const btn     = document.getElementById('advancedBtn');
  const isOpen  = !section.classList.contains('hidden');
  if (isOpen) { section.classList.add('hidden');    btn.textContent = '\u2699\uFE0F Erweiterte Einstellungen \u25B8'; }
  else         { section.classList.remove('hidden'); btn.textContent = '\u2699\uFE0F Erweiterte Einstellungen \u25BE'; }
});

// =======================
// WAKE LOCK
// =======================
let wakeLock = null;

async function toggleWakeLock() {
  try {
    if (!wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      document.getElementById('wakeLockBtn').classList.add('active');
    } else {
      await wakeLock.release();
      wakeLock = null;
      document.getElementById('wakeLockBtn').classList.remove('active');
    }
  } catch (err) { console.error('Wake Lock Fehler:', err); }
}

document.getElementById('wakeLockBtn').addEventListener('click', toggleWakeLock);

document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  if (wakeLock) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  if (document.getElementById('teamCarCheckbox').checked) {
    stopTeamCarTracking();
    startTeamCarTracking();
    showToast('\u{1F4CD} Tracker neugestartet \u2713');
  }
});

