// =======================
// DISPLAY-NACHRICHTEN
// Ein Feld je Tracker. Das Eingabefeld enthaelt den aktuell
// aktiven Text, damit man ihn abaendern statt neu tippen kann.
// =======================
function renderDisplayPanel() {
  if (!authToken || authLevel !== 'spolei') return '';

  const posIds = Object.keys(lastPosData)
    .filter(id => id !== 'TEAMAUTO' && lastPosData[id].type !== 'betreuer');

  // Tracker ohne Fix mitnehmen: sie sind online und adressierbar,
  // es fehlt nur die Position. Genau dafuer ist das hier da.
  const pendMap = Object.create(null);
  pendingTrackers.forEach(p => { pendMap[p.id] = p; });
  const pendIds = pendingTrackers.map(p => p.id).filter(id => posIds.indexOf(id) < 0);

  const ids = posIds.concat(pendIds).sort();

  if (ids.length === 0) {
    return `<div class="sl-panel"><div style="padding:11px 14px;border-bottom:1px solid #f0f0f0">
      <span style="font-size:13px;font-weight:500;color:#333">\u{1F4DF} Displays</span></div>
      <div style="padding:16px 14px;text-align:center;color:#bbb;font-size:13px">Noch keine Tracker</div></div>`;
  }

  let h = `<div class="sl-panel"><div style="padding:11px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f0f0f0">
    <span style="font-size:13px;font-weight:500;color:#333">\u{1F4DF} Displays</span>
    <span style="font-size:12px;color:#999">${ids.length} Tracker</span></div>`;

  ids.forEach(id => {
    const pos    = lastPosData[id] || {};
    const pend   = pendMap[id] || null;
    const name   = pos.displayName || (pend && pend.displayName) || id;
    const ageSec = pos.timestamp ? Math.round((Date.now() - pos.timestamp) / 1000) : 99999;
    const online = ageSec < 60;
    const txt    = displayTexts[id] || '';
    const auto   = displayAuto[id] === true;
    const state  = pend
      ? `<span style="font-size:11px;color:#546e7a;flex-shrink:0">\u{1F6F0} sucht GPS \u00B7 ${fmtDur(pend.since)}${pend.sats === null || pend.sats === undefined ? '' : ' \u00B7 ' + pend.sats + ' Sat'}</span>`
      : `<span style="font-size:11px;color:${online ? '#2e7d32' : '#bbb'};flex-shrink:0">${online ? 'aktiv' : 'offline'}</span>`;
    h += `<div style="padding:9px 14px;border-bottom:1px solid #f0f0f0">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;gap:8px">
        <span style="font-size:13px;font-weight:500;color:#333;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escH(name)}</span>
        ${state}
        <button class="btn" data-action="toggle-auto" data-id="${escH(id)}"
          style="flex-shrink:0;padding:3px 9px;font-size:11px;${auto ? 'background:#e8f5e9;color:#2e7d32;border-color:#a5d6a7' : ''}">
          ${auto ? '\u{1F916} Auto' : '\u270D Manuell'}</button>
      </div>
      ${auto
        ? `<div style="padding:7px 10px;background:#f5f5f5;border-radius:6px;font-size:13px;font-family:monospace;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escH(txt || '\u2013')}</div>`
        : `<div style="display:flex;gap:6px">
        <input type="text" class="disp-inp" data-id="${escH(id)}" maxlength="${displayMaxLen}"
          value="${escH(txt)}" placeholder="Nachricht\u2026"
          style="flex:1;min-width:0;padding:7px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;font-family:monospace">
        <button class="btn" data-action="send-display" data-id="${escH(id)}"
          style="flex:0;padding:7px 12px">\u27A4</button>
      </div>`}
    </div>`;
  });

  // Zaehler faerbt sich, sobald das Budget ausgereizt ist. Der Server
  // kuerzt zwar selbst, aber dann fehlen Nummern - das soll man sehen.
  const used  = displayPreview.length;
  const tight = used > displayMaxLen - 6;

  h += `<div style="padding:9px 14px;border-top:1px solid #f0f0f0;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
    <span style="font-size:11px;color:#888;flex:1;min-width:130px">Fremdnummern je Gruppe</span>
    <input type="number" class="ds-inp" data-key="foreignNrs" min="0" max="5" value="${displayCfg.foreignNrs}"
      style="width:56px;padding:5px 6px;border:1px solid #ddd;border-radius:6px;font-size:13px;text-align:center">
  </div>
  <div style="padding:9px 14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
    <span style="font-size:11px;color:#888;flex:1;min-width:130px">Keine Fremdnummern ab Gruppengr\u00F6\u00DFe</span>
    <input type="number" class="ds-inp" data-key="foreignNrsMaxSize" min="0" max="99" value="${displayCfg.foreignNrsMaxSize}"
      style="width:56px;padding:5px 6px;border:1px solid #ddd;border-radius:6px;font-size:13px;text-align:center">
  </div>`;

  h += `<div style="padding:8px 14px;font-size:11px;color:#aaa;line-height:1.5;border-top:1px solid #f0f0f0">
    Max. ${displayMaxLen} Zeichen. <b>;</b> neue Zeile, <b>~</b> neue Zeile die bei wenig Platz entf\u00E4llt.
    Leeres Feld senden l\u00F6scht die Anzeige. Favoriten \u2605 bleiben stehen,
    wenn der Platz knapp wird, und ignorieren die Gruppengr\u00F6\u00DFe.<br>
    Automatik sendet: <span style="font-family:monospace;color:#777">${escH(displayPreview || '\u2013')}</span>
    <span style="color:${tight ? '#e65100' : '#bbb'}">(${used}/${displayMaxLen})</span>
  </div></div>`;
  return h;
}

async function sendDisplay(id) {
  const inp = document.querySelector(`.disp-inp[data-id="${id}"]`);
  if (!inp) return;
  const text = inp.value;
  try {
    const res = await fetch(`${SERVER}/display`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ id, text })
    });
    if (!res.ok) { alert('\u274C Senden fehlgeschlagen'); return; }
    const data = await res.json();
    if (data.text && data.text.length > 0) displayTexts[id] = data.text;
    else                                    delete displayTexts[id];
    inp.value = data.text || '';
    inp.style.borderColor = '#4caf50';
    setTimeout(() => { inp.style.borderColor = '#ddd'; }, 1200);
  } catch (err) { alert('\u274C Fehler: ' + err.message); }
}

// m:ss seit einem Zeitstempel - fuer die Suchdauer
function fmtDur(since) {
  const sec = Math.max(0, Math.round((Date.now() - since) / 1000));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function escH(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function pollGroups() {
  // Waehrend und kurz nach einem eigenen Speichern nichts einspielen -
  // sonst ueberschreibt eine Antwort von vor dem Speichern den gerade
  // getippten Abstand.
  if (Date.now() < groupsWriteLock) return;
  try {
    const res  = await fetch(`${SERVER}/groups`);
    const next = await res.json();
    if (!Array.isArray(next)) return;
    // Zweite Pruefung: waehrend der Request lief, kann gespeichert
    // worden sein.
    if (Date.now() < groupsWriteLock) return;
    // Hat ein zweites Geraet die Gruppen geaendert, zeigt der eigene
    // Stapel auf einen Stand, den es nicht mehr gibt. Ein Undo wuerde
    // dann die Arbeit des Kollegen ueberschreiben - lieber kein Undo.
    const kommt = groupsSchluessel(next);
    if (lastSaved !== null && kommt !== lastSaved && undoStack.length) {
      undoStack = [];
      showToast('\u21B6 R\u00FCckg\u00E4ngig verworfen \u2013 anderes Ger\u00E4t hat ge\u00E4ndert');
    }
    lastSaved = kommt;
    taktikGroups = next;
    if (!taktikOpen) { renderStrip(taktikGroups); return; }
    // Offene Taktikansicht mitziehen, damit Aenderungen von einem
    // zweiten Geraet ankommen. Nicht neu zeichnen, solange jemand
    // tippt oder mitten in Aufteilen/Zusammenfuehren/Verschieben ist -
    // das wuerde den Vorgang abbrechen.
    const el   = document.activeElement;
    const typing = el && el.classList && (
      el.classList.contains('gap-inp')  || el.classList.contains('name-inp') ||
      el.classList.contains('disp-inp') || el.classList.contains('ds-inp')   ||
      el.classList.contains('add-rider-input'));
    if (!typing && !splittingGid && !mergingGid && !movingRider.gid) {
      // Eigene Drossel auf 30 s, der Poll selbst laeuft alle 5 s.
      await loadGapSeries(false);
      renderTaktikBody();
    }
  } catch (e) {}
}
