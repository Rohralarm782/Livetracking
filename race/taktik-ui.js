// =======================
// TAKTIK EVENT DELEGATION
// =======================
const tkBody = document.getElementById('taktikBody');

tkBody.addEventListener('click', function (e) {
  if (!authToken) return;
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, gid, id, nr } = btn.dataset;
  switch (action) {
    case 'undo':               undoLast();                        break;
    case 'add-group':          addGroup();                        break;
    case 'open-events':        openEventsPanel();                 break;
    case 'add-rider':          addRider(gid);                     break;
    case 'remove-rider':       removeRider(gid, parseInt(nr));    break;
    case 'delete-group':       deleteGroup(gid);                  break;
    case 'gap-plus':           adjustGap(gid, +15);               break;
    case 'gap-minus':          adjustGap(gid, -15);               break;
    case 'start-split':        startSplit(gid);                   break;
    case 'cancel-split':       cancelSplit();                     break;
    case 'confirm-split':      confirmSplit(gid, btn.dataset.direction); break;
    case 'start-merge':        startMerge(gid);                   break;
    case 'cancel-merge':       cancelMerge();                     break;
    case 'confirm-merge':      confirmMerge(gid, btn.dataset.target); break;
    case 'start-move-rider':   startMoveRider(gid, parseInt(nr)); break;
    case 'cancel-move-rider':  cancelMoveRider();                 break;
    case 'confirm-move-rider': confirmMoveRider(btn.dataset.target); break;
    case 'send-display':       sendDisplay(id);                   break;
    case 'toggle-auto':        toggleAuto(id);                    break;
    case 'set-main':           setMainGroup(gid);                 break;
    case 'toggle-fav':         toggleFav(parseInt(nr), btn.dataset.on === '1'); break;
    case 'open-favs':          openFavModal();                    break;
    case 'cycle-status':       cycleRiderStatus(parseInt(nr), btn.dataset.state || null); break;
  }
});

tkBody.addEventListener('change', function (e) {
  // Anzeige-Einstellungen: feuert beim Verlassen des Zahlenfeldes
  if (e.target.classList.contains('ds-inp')) { saveDisplaySettings(); return; }
  if (!e.target.classList.contains('split-check')) return;
  const nr = parseInt(e.target.dataset.nr);
  if (e.target.checked) splitNrs.add(nr); else splitNrs.delete(nr);
  tkBody.querySelectorAll('[data-action="confirm-split"]').forEach(btn => {
    btn.textContent = btn.dataset.direction === 'before'
      ? `\u2191 Vorne (${splitNrs.size})`
      : `\u2193 Hinten (${splitNrs.size})`;
  });
});

tkBody.addEventListener('focusout', function (e) {
  if (!authToken) return;
  const { gid } = e.target.dataset;
  if (!gid) return;
  const g = taktikGroups.find(g => g.id === gid);
  if (!g) return;
  if (e.target.classList.contains('name-inp')) {
    // Ein leeres Feld hiess bisher 'nichts tun'. Es heisst jetzt
    // 'wieder automatisch': der Platzhalter wird von
    // benenneGruppenNeu() noch in saveGroups() durch den Namen aus der
    // Fahrreihenfolge ersetzt - das ist der Rueckweg aus einem selbst
    // vergebenen Namen. renderTaktikBody() muss mit, weil im Feld
    // sonst der Platzhalter stehen bleibt.
    const v = e.target.value.trim();
    g.name = v || 'Gruppe';
    saveGroups(); renderTaktikBody(); renderStrip(taktikGroups);
  }
  if (e.target.classList.contains('gap-inp')) {
    g.gapPrev = g.gap;
    g.gap = e.target.value.trim() || null;
    saveGroups(); renderTaktikBody(); renderStrip(taktikGroups);
  }
});

tkBody.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter') return;
  if (e.target.classList.contains('add-rider-input')) { e.preventDefault(); addRider(e.target.dataset.gid); }
  if (e.target.classList.contains('gap-inp') || e.target.classList.contains('name-inp')) { e.target.blur(); }
  if (e.target.classList.contains('disp-inp')) { e.preventDefault(); sendDisplay(e.target.dataset.id); }
});

// =======================
// TAKTIK RENDER
// =======================
// Ab 2.0 koennen mehrere Rennen gleichzeitig laufen. Der Streifen ist
// 70 px breit und sitzt am rechten Rand - auf einem Handy waere kein
// Platz fuer zwei davon nebeneinander.
//
// Bis 2.0.0 stand darueber ein Reiter je Rennen. Das war irrefuehrend:
// der Reiter schaltete nur die Beschriftung um, nicht die Datenquelle.
// groups gibt es im Server genau einmal und gehoert dem Leitrennen -
// ein fremdes Kuerzel ueber echten Gruppendaten waere im Rennen die
// gefaehrlichere Variante.
//
// Ab 2.1.0 steht deshalb nur noch ein Kopf da, und zwar mit dem Rennen,
// dessen Taktik der Streifen tatsaechlich zeigt. Bei einem einzigen
// laufenden Rennen entfaellt er: dann ist nichts zu verwechseln.
function renderStripReiter() {
  if (typeof laufendeRennen !== 'function' || laufendeRennen() < 2) return '';
  const id = (typeof activeInfo === 'object' && activeInfo) ? activeInfo.raceId : null;
  if (!id) return '';
  const s     = (typeof steckbriefOf === 'function') ? steckbriefOf(id) : null;
  const farbe = (s && s.farbe) ? s.farbe : '#607d8b';
  const lbl   = (s && s.name) ? s.name : id;
  return `<div class="stripKopf" style="border-bottom-color:${farbe}"`
       + ` title="Taktik des Leitrennens">`
       + `<span class="stripKopfP" style="background:${farbe}"></span>`
       + `${escH(String(lbl).slice(0, 6))}</div>`;
}

function renderStrip(grps) {
  const strip = document.getElementById('taktikStrip');
  // filter(Boolean) VOR dem Zaehlen: sonst zeigen die Verbindungslinien
  // auf die Indizes der ungefilterten Liste.
  const list = Array.isArray(grps) ? grps.filter(Boolean) : [];
  const reiter = renderStripReiter();
  if (list.length === 0 && !reiter) { strip.classList.add('hidden'); return; }
  strip.classList.remove('hidden');
  strip.innerHTML = reiter + list.map((g, i) => {
    // Wie auf dem Garmin: DSQ und DNF zaehlen nicht mehr mit.
    const cnt      = (g.riders||[]).filter(r =>
      !(r && (r.status === 'dsq' || r.status === 'dnf'))).length;
    // g.name kann fehlen, wenn eine Gruppe ueber die API angelegt
    // wurde. Frueher warf .length hier - und weil pollGroups() den
    // Fehler schluckt, hoerte der Streifen einfach auf zu leben.
    const nm       = String(g.name || 'Gruppe');
    const lbl      = nm.length > 7 ? nm.slice(0, 6) + '.' : nm;
    const nextGap  = list[i + 1] ? list[i + 1].gap  : null;
    const nextPrev = list[i + 1] ? list[i + 1].gapPrev : null;
    const conn     = i < list.length - 1
      ? `<div class="strip-conn">
           <div class="strip-line"></div>
           <div class="strip-gap">${nextGap ? '+' + escH(nextGap) : '\u2013'}${trendArrow(nextGap, nextPrev)}</div>
           <div class="strip-line"></div>
         </div>` : '';
    return `<div class="strip-grp">
      <div class="strip-dot" style="background:${g.color}"></div>
      <div class="strip-name">${escH(lbl)}</div>
      <div class="strip-cnt">${cnt}</div>
    </div>${conn}`;
  }).join('');
  // Der Kopf ist reine Beschriftung und faengt nichts ab: ein Tipp auf
  // den Streifen soll die Taktik oeffnen, egal wo er landet. Das eigene
  // Rennen wird ueber die Rennleiste oben gesetzt.
}

function renderTaktikBody() {
  let html = '';
  if (authToken) {
    const ar = activeRace();
    html += `<div class="sl-panel">
      <div class="sl-item" style="border-bottom:none">
        <div class="sl-dot" style="background:${ar ? '#4caf50' : '#ddd'}"></div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500;color:${ar ? '#333' : '#999'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${
            ar ? escH(raceLabel(ar.id, true)) : 'Kein Rennen aktiv'}</div>
          <div style="font-size:11px;color:#aaa;margin-top:2px">${
            ar ? `${ar.riderCount} Fahrer${ar.category ? ' \u00B7 ' + escH(ar.category) : ''}`
               : 'Rennen anlegen oder aktivieren'}</div>
        </div>
        <button class="btn" data-action="open-events"
          style="flex:0;padding:5px 10px;font-size:12px">\u{1F3C1} Rennen</button>
      </div>
    </div>`;
    // Rueckgaengig steht bewusst links aussen und ist schmal: er wird
    // im fahrenden Auto getroffen, aber nicht versehentlich.
    const uLetzt = undoStack.length ? undoStack[undoStack.length - 1].label : null;
    html += `<div style="display:flex;gap:8px;margin-bottom:12px">
      <button class="btn" data-action="undo" style="flex:0;padding:8px 12px"${
        uLetzt ? ` title="${escH(uLetzt)} r\u00FCckg\u00E4ngig"` : ' disabled title="Nichts r\u00FCckg\u00E4ngig zu machen"'
      }>\u21B6${uLetzt ? ' ' + escH(uLetzt) : ''}</button>
      <button class="btn" data-action="add-group" style="flex:1">\uFF0B Gruppe</button>
      <button class="btn" data-action="open-favs" style="flex:1"${
        activeRaceId ? '' : ' disabled title="Erst ein Rennen aktivieren"'}>\u2B50 Favoriten</button>
    </div>`;
    // Zeitmessung: der Vorschlag steht ueber den Gruppen, nicht in
    // einem Fenster davor. Ohne Vorschlag liefert timingBanner() ''.
    if (typeof timingBanner === 'function') html += timingBanner();
  }
  if (taktikGroups.length === 0) {
    html += `<div style="text-align:center;color:#bbb;padding:40px 20px;font-size:14px">
      ${authToken ? 'Noch keine Gruppen \u2013 oben auf \uFF0B Gruppe tippen' : 'Noch keine Gruppen angelegt'}
    </div>`;
  } else {
    const mIdx = mainGroupIdx();
    taktikGroups.forEach((g, idx) => {
      const riders    = g.riders || [];
      const isLeading = idx === 0;
      const isMain    = idx === mIdx;
      const others    = taktikGroups.filter(tg => tg.id !== g.id);
      if (splittingGid === g.id) {
        const rows = riders.map(r => {
          const n = r.nr !== undefined ? r.nr : r;
          return `<div class="r-row">
            <input type="checkbox" class="split-check" data-nr="${n}"
              style="width:18px;height:18px;cursor:pointer;flex-shrink:0;accent-color:#2196F3">
            <span class="r-nr">${n}</span>
            <div>${r.name ? `<div class="r-name">${escH(r.name)}</div>` : `<div class="r-none">kein Eintrag</div>`}</div>
          </div>`;
        }).join('');
        html += `<div class="gc" style="border-color:#bbdefb">
          <div style="height:3px;background:${g.color}"></div>
          <div class="gc-hdr" style="background:#e3f2fd">
            <span style="font-size:13px;font-weight:500;color:#1565c0">\u2702 ${escH(g.name)} aufteilen</span>
            <button class="btn" data-action="cancel-split" style="padding:3px 8px;font-size:11px">\u2715</button>
          </div>
          <div class="gc-sec"><div style="font-size:11px;color:#999;margin-bottom:8px">Fahrer w\u00E4hlen, die sich absetzen:</div>${rows}</div>
          <div class="gc-sec" style="display:flex;gap:6px">
            <button class="btn" data-action="confirm-split" data-gid="${g.id}" data-direction="before"
              style="flex:1;background:#e3f2fd;color:#1565c0;border-color:#90caf9;font-size:12px">\u2191 Vorne (0)</button>
            <button class="btn" data-action="confirm-split" data-gid="${g.id}" data-direction="after"
              style="flex:1;background:#fce4ec;color:#880e4f;border-color:#f48fb1;font-size:12px">\u2193 Hinten (0)</button>
          </div>
        </div>`;
        return;
      }
      if (mergingGid === g.id) {
        html += `<div class="gc" style="border-color:#ffe0b2">
          <div style="height:3px;background:${g.color}"></div>
          <div class="gc-hdr" style="background:#fff3e0">
            <span style="font-size:13px;font-weight:500;color:#e65100">\u2295 ${escH(g.name)} zusammenf\u00FChren</span>
            <button class="btn" data-action="cancel-merge" style="padding:3px 8px;font-size:11px">\u2715</button>
          </div>
          <div class="gc-sec">
            <div style="font-size:11px;color:#999;margin-bottom:8px">Fahrer in welche Gruppe verschieben?</div>
            ${others.map(tg => `
              <button class="btn" data-action="confirm-merge" data-gid="${g.id}" data-target="${tg.id}"
                style="width:100%;margin-bottom:6px;display:flex;align-items:center;gap:7px;padding:8px 12px">
                <div style="width:9px;height:9px;border-radius:50%;background:${tg.color};flex-shrink:0"></div>
                ${escH(tg.name)}</button>`).join('')}
          </div>
        </div>`;
        return;
      }
      const trend   = trendArrow(g.gap, g.gapPrev);
      // Annaeherungsrate aus dem Abstandsverlauf. Die Zahl beantwortet
      // die einzige Frage, die im Auto zaehlt: reicht es noch?
      const rate    = gapRate(g.id);
      let rateHtml  = '';
      if (rate !== null && Math.abs(rate) >= 1) {
        const closing = rate < 0;
        const perMin  = Math.round(Math.abs(rate));
        const secNow  = gapToSec(g.gap);
        // Nur eine Prognose wagen, wenn sie in einer Groessenordnung
        // liegt, die im Rennen noch etwas heisst.
        const eta = (closing && secNow) ? Math.round(secNow / Math.abs(rate)) : null;
        const etaTxt = (eta !== null && eta >= 1 && eta <= 45) ? ` \u00B7 dran in ~${eta} min` : '';
        rateHtml = `<div style="font-size:10px;margin-top:2px;text-align:right;color:${
          closing ? '#2e7d32' : '#c62828'}">${closing ? '\u25BC' : '\u25B2'} ${perMin} s/min${etaTxt}</div>`;
      }
      const gapHtml = isLeading
        ? `<span style="font-size:12px;padding:3px 9px;border-radius:12px;background:#e8f5e9;color:#2e7d32">F\u00FChrend</span>`
        : authToken
          ? `<div style="display:flex;align-items:center;gap:2px">
               <button data-action="gap-minus" data-gid="${g.id}" style="padding:2px 7px;font-size:16px;color:#666;min-width:unset;flex:0">\u2212</button>
               <input class="gap-inp" data-gid="${g.id}" value="${escH(g.gap||'')}" placeholder="0:00"
                 style="width:46px;font-size:13px;padding:3px 5px;border:1px solid #ddd;border-radius:6px;text-align:center">
               <button data-action="gap-plus" data-gid="${g.id}" style="padding:2px 7px;font-size:16px;color:#666;min-width:unset;flex:0">+</button>
               ${trend}</div>`
          : g.gap
            ? `<span style="font-size:12px;padding:3px 9px;border-radius:12px;background:#e3f2fd;color:#1565c0">+${escH(g.gap)}${trend}</span>`
            : '';
      const nameHtml = authToken
        ? `<input class="name-inp" data-gid="${g.id}" value="${escH(g.name)}"
             style="font-size:14px;font-weight:500;border:none;background:transparent;color:#333;padding:0;width:120px;max-width:45vw">`
        : `<span style="font-size:14px;font-weight:500;color:#333">${escH(g.name)}</span>`;
      // Hauptfeld-Marker. Jederzeit verschiebbar: ein Klick auf das
      // graue HF einer anderen Gruppe setzt ihn dorthin um.
      const hfHtml = isMain
        ? `<span title="Hauptfeld \u2013 hier endet der Text auf dem Garmin"
             style="flex-shrink:0;font-size:11px;font-weight:600;padding:2px 6px;border-radius:10px;background:#e8f5e9;color:#2e7d32;border:1px solid #a5d6a7">HF</span>`
        : authToken
          ? `<button class="btn" data-action="set-main" data-gid="${g.id}" title="Als Hauptfeld markieren"
               style="flex:0;flex-shrink:0;min-width:unset;padding:2px 6px;font-size:11px;color:#ccc;border-color:#eee">HF</button>`
          : '';
      const riderRows = riders.map(r => {
        const nr = r.nr !== undefined ? r.nr : r;
        if (authToken && movingRider.gid === g.id && movingRider.nr === nr) {
          return `<div class="r-row" style="background:#f9f9f9;border-radius:6px;padding:5px;flex-wrap:wrap;gap:4px">
            <span class="r-nr">${nr}</span>
            <span style="font-size:11px;color:#999;flex-shrink:0">\u2192</span>
            ${others.map(tg => `
              <button class="btn" data-action="confirm-move-rider" data-target="${tg.id}"
                style="display:flex;align-items:center;gap:4px;padding:3px 7px;font-size:11px;flex-shrink:0">
                <div style="width:7px;height:7px;border-radius:50%;background:${tg.color};flex-shrink:0"></div>
                ${escH(tg.name.length > 9 ? tg.name.slice(0,8)+'.' : tg.name)}</button>`).join('')}
            <button class="btn" data-action="cancel-move-rider" style="padding:3px 7px;font-size:11px;flex-shrink:0">\u2715</button>
          </div>`;
        }
        // Der Stern haengt an der Startliste - ohne Eintrag dort kann
        // ein Fahrer kein Favorit sein, dann wird er gar nicht gezeigt.
        const inList = r.name !== undefined && r.name !== null;
        const st     = r.status || null;
        const stDef  = st ? RIDER_STATE_LABEL[st] : null;
        // Ausgeschiedene Fahrer bleiben stehen, aber sichtbar
        // abgesetzt: sie zaehlen nicht mehr in die Gruppengroesse
        // und stehen nicht mehr auf dem Garmin.
        const outRow = (st === 'dsq' || st === 'dnf');
        const stBtn  = (authToken && inList)
          ? `<button class="btn" data-action="cycle-status" data-nr="${nr}" data-state="${st || ''}"
               title="${stDef ? stDef.title : 'Zustand'} \u2013 tippen: verwarnt \u203A DSQ \u203A DNF \u203A normal"
               style="padding:1px 5px;font-size:10px;font-weight:600;line-height:1.4;min-width:unset;flex:0;
                      background:${stDef ? stDef.bg : '#fff'};color:${stDef ? stDef.fg : '#ccc'};
                      border-color:${stDef ? stDef.bd : '#eee'}">${stDef ? stDef.txt : '\u26A0'}</button>`
          : (stDef
              ? `<span title="${stDef.title}" style="flex-shrink:0;font-size:10px;font-weight:600;padding:1px 5px;
                   border-radius:5px;background:${stDef.bg};color:${stDef.fg};border:1px solid ${stDef.bd}">${stDef.txt}</span>`
              : '');
        const favBtn = (authToken && inList)
          ? `<button class="btn" data-action="toggle-fav" data-nr="${nr}" data-on="${r.fav ? '0' : '1'}"
               title="${r.fav ? 'Favorit entfernen' : 'Als Favorit markieren'}"
               style="padding:1px 4px;font-size:13px;line-height:1.2;min-width:unset;flex:0;
                      border-color:${r.fav ? '#ffca28' : '#eee'};color:${r.fav ? '#f9a825' : '#ccc'}">${
              r.fav ? '\u2605' : '\u2606'}</button>`
          : '';
        return `<div class="r-row"${outRow ? ' style="opacity:0.55"' : ''}>
          ${authToken ? `<button class="btn" data-action="remove-rider" data-gid="${g.id}" data-nr="${nr}"
            style="padding:1px 5px;font-size:11px;color:#f44336;min-width:unset;flex:0">\u2715</button>` : ''}
          <span class="r-nr"${r.fav ? ' style="background:#fff8e1;color:#f9a825;font-weight:700"' : ''}>${nr}</span>
          ${favBtn}
          ${stBtn}
          <div style="flex:1">${r.name
            ? `<div class="r-name"${outRow ? ' style="text-decoration:line-through"' : ''}>${escH(r.name)}</div><div class="r-team">${escH(r.team||'')}</div>`
            : `<div class="r-none">kein Eintrag</div>`
          }</div>
          ${(authToken && others.length > 0) ? `
            <button class="btn" data-action="start-move-rider" data-gid="${g.id}" data-nr="${nr}"
              style="padding:2px 6px;font-size:12px;color:#666;min-width:unset;flex:0" title="Fahrer verschieben">\u2192</button>` : ''}
        </div>`;
      }).join('');
      const extraBtns = authToken ? [
        riders.length >= 2 ? `<button class="btn" data-action="start-split" data-gid="${g.id}"
          style="flex:1;font-size:12px;color:#555">\u2702 Aufteilen</button>` : '',
        others.length > 0 ? `<button class="btn" data-action="start-merge" data-gid="${g.id}"
          style="flex:1;font-size:12px;color:#555">\u2295 Zusammenf\u00FChren</button>` : ''
      ].filter(Boolean).join('') : '';
      const footer = authToken ? `
        <div class="gc-sec" style="display:flex;gap:8px">
          <input type="number" class="add-rider-input" data-gid="${g.id}" min="1" placeholder="Nr."
            style="flex:1;min-width:60px;padding:7px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">
          <button class="btn" data-action="add-rider"    data-gid="${g.id}" style="flex:1">\uFF0B Fahrer</button>
          <button class="btn" data-action="delete-group" data-gid="${g.id}" style="flex:0;padding:7px 10px;color:#f44336">\u{1F5D1}</button>
        </div>
        ${extraBtns ? `<div class="gc-sec" style="border-top:1px dashed #f0f0f0;padding-top:6px;padding-bottom:6px;display:flex;gap:6px">${extraBtns}</div>` : ''}
      ` : '';
      html += `<div class="gc">
        <div style="height:3px;background:${g.color}"></div>
        <div class="gc-hdr">
          <div style="display:flex;align-items:center;gap:7px;min-width:0">
            <div class="gc-dot" style="background:${g.color}"></div>
            ${nameHtml}
            ${typeof timingSrcBadge === 'function' ? timingSrcBadge(g) : ''}
            ${hfHtml}
          </div>
          <div style="flex-shrink:0">${gapHtml}${rateHtml}</div>
        </div>
        ${riders.length > 0 ? `<div class="gc-sec">${riderRows}</div>` : ''}
        ${footer}
      </div>`;
    });
  }
  html += renderDisplayPanel();
  // Bewegungen ganz unten: die Gruppenkarten sind die Arbeitsflaeche,
  // die Liste ist Nachschlagewerk. Zugeklappt, mit Zaehler fuer Neues.
  if (typeof timingBewegungen === 'function') html += timingBewegungen();
  tkBody.innerHTML = html;
}
