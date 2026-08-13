// =======================
// GPX TRACKS
// =======================
let gpxLayer = null;

async function fetchGpxTrack() {
  try {
    const res  = await fetch(`${SERVER}/gpx`);
    const data = await res.json();
    if (data && data.coords && data.coords.length > 0) {
      drawGpxLayer(data.coords);
    }
  } catch (err) { console.error('GPX fetch:', err); }
}

function drawGpxLayer(coords) {
  if (gpxLayer) { map.removeLayer(gpxLayer); gpxLayer = null; }
  gpxLayer = L.polyline(coords, {
    color: '#e65100', weight: 4, opacity: 0.8, lineJoin: 'round', lineCap: 'round'
  }).addTo(map);
  if (authToken) document.getElementById('gpxRemoveBtn').classList.remove('hidden');
}

document.getElementById('gpxBtn').addEventListener('click', () => {
  setTimeout(() => optionsMenu.classList.add('hidden'), 50);
  document.getElementById('gpxFileInput').click();
});

document.getElementById('gpxFileInput').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const coords = parseGpx(e.target.result);
      drawGpxLayer(coords);
      await fetch(`${SERVER}/gpx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ coords, name: file.name })
      });
    } catch (err) { alert('\u274C ' + err.message); }
    this.value = '';
  };
  reader.readAsText(file);
});

function parseGpx(xmlText) {
  const parser = new DOMParser();
  const xml    = parser.parseFromString(xmlText, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('Ung\u00FCltige GPX-Datei');
  const coords = [];
  xml.querySelectorAll('trkpt').forEach(pt => {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    if (!isNaN(lat) && !isNaN(lon)) coords.push([lat, lon]);
  });
  if (coords.length === 0) {
    xml.querySelectorAll('rtept').forEach(pt => {
      const lat = parseFloat(pt.getAttribute('lat'));
      const lon = parseFloat(pt.getAttribute('lon'));
      if (!isNaN(lat) && !isNaN(lon)) coords.push([lat, lon]);
    });
  }
  if (coords.length === 0) throw new Error('Keine Track-Punkte gefunden');
  return coords;
}

document.getElementById('gpxRemoveBtn').addEventListener('click', async () => {
  if (gpxLayer) { map.removeLayer(gpxLayer); gpxLayer = null; }
  document.getElementById('gpxRemoveBtn').classList.add('hidden');
  try {
    await fetch(`${SERVER}/gpx`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
  } catch (err) { console.error('GPX delete:', err); }
});

