// =======================
// MAIN LOOP
// =======================
loadPositions();
setInterval(loadPositions, 1000);
loadPending();
setInterval(loadPending, 3000);
fetchGpxTrack();
loadMode();
pollGroups();
setInterval(pollGroups, 5000);

// =======================
// TOAST
// =======================
function showToast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'position:fixed;bottom:70px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.75);color:white;padding:8px 18px;border-radius:20px;font-size:13px;z-index:9999;pointer-events:none;';
  document.body.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity 0.5s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 500); }, 2500);
}

// =======================
// SERVICE WORKER (PWA)
// =======================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(e => console.error('SW:', e));
}

