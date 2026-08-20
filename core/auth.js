const SERVER = 'https://livetracking-fq4l.onrender.com';

// =======================
// AUTH STATE
// =======================
let authToken   = null;
let authLevel   = null;   // 'spolei' | 'betreuer' | null
let currentMode = 'race';

function showAdminElements() {
  document.getElementById('advRaceGroup').classList.remove('hidden');
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
}

function hideAdminElements() {
  document.getElementById('advRaceGroup').classList.add('hidden');
  closeAdvanced();
  document.getElementById('logoutBtn').classList.add('hidden');
  document.getElementById('teamCarToggle').classList.add('hidden');
  document.getElementById('betreuerBtn').classList.add('hidden');
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
// Rueckgabe: true = Antwort ist brauchbar, false = Sitzung ist hin.
let authWarned = false;

function checkAuth(res) {
  if (!res || (res.status !== 401 && res.status !== 403)) return true;
  // Nicht angemeldet zu sein ist kein Sitzungsabbruch.
  if (!authToken) return false;
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
