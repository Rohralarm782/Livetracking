const SERVER = 'https://livetracking-fq4l.onrender.com';

// =======================
// AUTH STATE
// =======================
let authToken   = null;
let authLevel   = null;   // 'spolei' | 'betreuer' | null
let currentMode = 'race';

function showAdminElements() {
  document.getElementById('advRaceGroup').classList.remove('hidden');
  document.getElementById('eventsBtn').classList.remove('hidden');
  document.getElementById('logoutBtn').classList.remove('hidden');
  document.getElementById('teamCarToggle').classList.remove('hidden');
  document.getElementById('loginBtnTop').classList.add('hidden');
  document.getElementById('betreuerBtn').classList.add('hidden');
}

function showBetreuerElements() {
  document.getElementById('logoutBtn').classList.remove('hidden');
  document.getElementById('betreuerBtn').classList.remove('hidden');
  document.getElementById('loginBtnTop').classList.add('hidden');
  document.getElementById('advRaceGroup').classList.add('hidden');
  document.getElementById('teamCarToggle').classList.add('hidden');
  document.getElementById('eventsBtn').classList.add('hidden');
  beendeRennverwaltung();
  beendeStreckenModus();
}

// loadToken() laeuft schon beim Laden von auth.js - map/gpx.js, wo
// setStreckenModus() steht, ist da noch nicht geladen. Ein direkter
// Aufruf haette einem angemeldeten Betreuer die ganze Seite mit einem
// ReferenceError zerlegt.
function beendeStreckenModus() {
  if (typeof setStreckenModus === 'function') setStreckenModus(false);
}

// Gleicher Grund wie oben: loadToken() laeuft, bevor race/events-ui.js
// geladen ist. Ohne den typeof-Riegel wuerde ein angemeldeter Betreuer
// beim Seitenaufbau in einen ReferenceError laufen.
function beendeRennverwaltung() {
  if (typeof eventsOpen === 'boolean' && eventsOpen
      && typeof closeEventsPanel === 'function') closeEventsPanel();
}

function hideAdminElements() {
  document.getElementById('advRaceGroup').classList.add('hidden');
  closeAdvanced();
  document.getElementById('logoutBtn').classList.add('hidden');
  document.getElementById('teamCarToggle').classList.add('hidden');
  document.getElementById('betreuerBtn').classList.add('hidden');
  document.getElementById('eventsBtn').classList.add('hidden');
  beendeRennverwaltung();
  beendeStreckenModus();
  document.getElementById('loginBtnTop').classList.remove('hidden');
}

function saveToken(token, level) {
  authToken   = token;
  authLevel   = level;
  authWarned  = false;
  localStorage.setItem('authToken', token);
  localStorage.setItem('authLevel', level);
  document.getElementById('loginModal').classList.add('hidden');
  if (level === 'spolei') showAdminElements();
  else                    showBetreuerElements();
  console.log(`\u2705 Eingeloggt als ${level}`);
}

function loadToken() {
  authToken = localStorage.getItem('authToken');
  authLevel = localStorage.getItem('authLevel');
  if (authToken && authLevel) {
    if (authLevel === 'spolei') showAdminElements();
    else                        showBetreuerElements();
  }
}

function logout() {
  if (authToken) {
    fetch(`${SERVER}/logout`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` }
    }).catch(console.error);
  }
  authToken = null;
  authLevel = null;
  localStorage.removeItem('authToken');
  localStorage.removeItem('authLevel');
  stopTeamCarTracking();
  document.getElementById('teamCarCheckbox').checked = false;
  document.getElementById('loginModal').classList.add('hidden');
  hideAdminElements();
  console.log("\u{1F6AA} Abgemeldet");
}

// =======================
// ABGELAUFENE SITZUNG
// =======================
// Bisher hat keine einzige Stelle im Frontend auf 401/403 reagiert.
// Nach einem Cold Start von Render waren alle Tokens weg, das Handy
// hielt seinen aber weiter - man sah sich als eingeloggt, und jedes
// Speichern lief still ins Leere. checkAuth() wird jetzt von allen
// schreibenden Aufrufen durchgereicht.
//
// Ab 2.5.0 werden 401 und 403 getrennt behandelt. Mit zwei Rollen sind
// das zwei verschiedene Lagen:
//   401 = der Token gilt nicht mehr  -> abmelden, neu anmelden lassen
//   403 = angemeldet, aber nicht befugt -> Sitzung bleibt, nur Hinweis
// Bis 2.4.1 loeste beides eine Abmeldung aus. Ein Betreuer, der einmal
// auf einen SpoLei-Knopf tippt, flog damit mitten im Rennen aus der
// Sitzung - genau der Fehlgriff, gegen den diese Version gebaut ist.
//
// Rueckgabe: true = Antwort ist brauchbar, false = Aufruf ist gescheitert.
let authWarned = false;
let rechtWarned = false;

function checkAuth(res) {
  if (!res || (res.status !== 401 && res.status !== 403)) return true;
  // Nicht angemeldet zu sein ist kein Sitzungsabbruch.
  if (!authToken) return false;
  if (res.status === 403) {
    if (!rechtWarned) {
      rechtWarned = true;
      if (typeof showToast === 'function') {
        showToast('\u{1F512} Daf\u00FCr fehlt die Berechtigung');
      }
      setTimeout(() => { rechtWarned = false; }, 3000);
    }
    return false;
  }
  authToken = null;
  authLevel = null;
  localStorage.removeItem('authToken');
  localStorage.removeItem('authLevel');
  hideAdminElements();
  if (!authWarned) {
    authWarned = true;
    showLoginModal('\u26A0\uFE0F Sitzung abgelaufen \u2013 bitte neu anmelden');
    setTimeout(() => { authWarned = false; }, 3000);
  }
  return false;
}

function showLoginModal(reason) {
  document.getElementById('loginReason').textContent = reason || 'SpoLei- oder Betreuer-Passwort eingeben';
  document.getElementById('loginModal').classList.remove('hidden');
  document.getElementById('loginError').textContent = '';
  setTimeout(() => document.getElementById('passwordInput').focus(), 50);
}

document.getElementById('loginBtnTop').addEventListener('click', () => showLoginModal());

document.getElementById('loginBtn').addEventListener('click', async () => {
  const password = document.getElementById('passwordInput').value;
  const errorEl  = document.getElementById('loginError');
  if (!password) { errorEl.textContent = '\u274C Passwort erforderlich'; return; }
  try {
    const res  = await fetch(`${SERVER}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (!res.ok) { errorEl.textContent = '\u274C Falsches Passwort'; return; }
    saveToken(data.token, data.level);
    document.getElementById('passwordInput').value = '';
    errorEl.textContent = '';
    closeOptionsMenu();
  } catch (err) { errorEl.textContent = '\u274C Fehler: ' + err.message; }
});

document.getElementById('passwordInput').addEventListener('keypress', e => {
  if (e.key === 'Enter') document.getElementById('loginBtn').click();
});

document.getElementById('logoutBtn').addEventListener('click', logout);
loadToken();
