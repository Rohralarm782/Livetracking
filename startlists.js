// =======================
// KI-IMPORT STARTLISTE
// =======================
let aiRiders = [];

function openAiImport() {
  aiRiders = [];
  document.getElementById('aiCategory').value = '';
  document.getElementById('aiStatus').style.display = 'none';
  document.getElementById('aiPreviewSection').style.display = 'none';
  document.getElementById('aiImportModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('aiCategory').focus(), 50);
}

document.getElementById('aiCancelBtn').addEventListener('click', () => {
  document.getElementById('aiImportModal').classList.add('hidden');
});

document.getElementById('aiFilePickBtn').addEventListener('click', () => {
  const cat = document.getElementById('aiCategory').value.trim();
  if (!cat) { document.getElementById('aiCategory').focus(); return; }
  document.getElementById('startlistFileInput').click();
});

document.getElementById('aiSaveBtn').addEventListener('click', async () => {
  const name = document.getElementById('aiListName').value.trim();
  if (!name || aiRiders.length === 0) return;
  const btn = document.getElementById('aiSaveBtn');
  btn.disabled = true; btn.textContent = '\u23F3 Speichern\u2026';
  try {
    const res = await fetch(`${SERVER}/startlists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ name, riders: aiRiders })
    });
    if (!res.ok) throw new Error('Server-Fehler');
    document.getElementById('aiImportModal').classList.add('hidden');
    await loadStartlists();
    renderTaktikBody();
  } catch (err) {
    alert('\u274C ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = '\u2705 Speichern';
  }
});

function aiPrompt(category) {
  return `Extrahiere alle Fahrer der Kategorie "${category}" aus dieser Startliste.\n\nAntworte NUR mit einem JSON-Array, ohne Text, ohne Backticks:\n[{"nr": null, "name": "NACHNAME Vorname", "team": "Teamname"}, ...]\n\nFalls Startnummern vorhanden sind, trage sie als Zahl ein. Sonst null.\nFalls keine Fahrer f\u00FCr diese Kategorie gefunden werden: []`;
}

document.getElementById('startlistFileInput').addEventListener('change', async function () {
  const file = this.files[0];
  if (!file) return;
  this.value = '';

  const category  = document.getElementById('aiCategory').value.trim();
  const statusEl2 = document.getElementById('aiStatus');
  const previewEl = document.getElementById('aiPreviewSection');
  aiRiders = [];
  statusEl2.style.display = 'block';
  previewEl.style.display = 'none';

  try {
    const ext = file.name.split('.').pop().toLowerCase();
    let apiBody;

    if (ext === 'pdf') {
      statusEl2.textContent = '\u23F3 PDF wird gelesen\u2026';
      const ab    = await file.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let binary  = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      apiBody = {
        model: 'claude-sonnet-4-6', max_tokens: 8000,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: aiPrompt(category) }
        ]}]
      };
    } else {
      statusEl2.textContent = '\u23F3 Datei wird gelesen\u2026';
      let text;
      if (ext === 'xlsx' || ext === 'xls') {
        const ab = await file.arrayBuffer();
        const wb = XLSX.read(new Uint8Array(ab), { type: 'array' });
        text = wb.SheetNames.map(n => `[${n}]\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n\n');
      } else {
        text = await file.text();
      }
      apiBody = {
        model: 'claude-sonnet-4-6', max_tokens: 8000,
        messages: [{ role: 'user', content: `${aiPrompt(category)}\n\n${text}` }]
      };
    }

    statusEl2.textContent = '\u{1F916} KI analysiert\u2026';
    const res  = await fetch(`${SERVER}/api/claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify(apiBody)
    });
    if (!res.ok) throw new Error(`API-Fehler ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error('API: ' + (data.error.message || JSON.stringify(data.error)));
    const raw  = (data.content || []).map(b => b.text || '').join('');
    const m    = raw.match(/\[[\s\S]*\]/);
    if (!m) {
      const cut = data.stop_reason === 'max_tokens' ? ' (Antwort abgeschnitten \u2013 Datei zu gro\u00DF)' : '';
      throw new Error('Keine Fahrerliste in der Antwort' + cut + ': ' + raw.slice(0, 200));
    }
    aiRiders = JSON.parse(m[0]);

    if (aiRiders.length === 0) {
      statusEl2.textContent = `\u26A0\uFE0F Keine Fahrer f\u00FCr \u201E${category}\u201C gefunden \u2013 Bezeichnung pr\u00FCfen.`;
      return;
    }

    statusEl2.style.display = 'none';
    document.getElementById('aiRiderCount').textContent = `\u2705 ${aiRiders.length} Fahrer gefunden`;
    document.getElementById('aiListName').value = `${category} \u2013 ${file.name.replace(/\.[^.]+$/, '')}`;
    document.getElementById('aiPreviewBody').innerHTML = aiRiders.map(r =>
      `<tr><td>${r.nr ?? '\u2013'}</td><td>${escH(r.name)}</td><td>${escH(r.team || '')}</td></tr>`
    ).join('');
    previewEl.style.display = 'block';

  } catch (err) {
    statusEl2.textContent = '\u274C ' + err.message;
  }
});

