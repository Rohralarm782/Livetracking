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
    case 'add-group':          addGroup();                        break;
    case 'new-race':           neuesRennen();                     break;
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
    case 'activate-list':      activateStartlist(id);             break;
    case 'delete-list':        deleteStartlist(id);               break;
    case 'upload-startlist':   openAiImport();                    break;
  }
});

tkBody.addEventListener('change', function (e) {
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
    const v = e.target.value.trim();
    if (v) { g.name = v; saveGroups(); renderStrip(taktikGroups); }
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
function renderStrip(grps) {
  const strip = document.getElementById('taktikStrip');
  if (!grps || grps.length === 0) { strip.classList.add('hidden'); return; }
  strip.classList.remove('hidden');
  strip.innerHTML = grps.map((g, i) => {
    const cnt      = (g.riders||[]).length;
    const lbl      = g.name.length > 7 ? g.name.slice(0, 6) + '.' : g.name;
    const nextGap  = grps[i + 1] ? grps[i + 1].gap  : null;
    const nextPrev = grps[i + 1] ? grps[i + 1].gapPrev : null;
    const conn     = i < grps.length - 1
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
}

function renderTaktikBody() {
  let html = '';
  if (authToken) {
    const active = startlistMeta.find(s => s.id === activeSlId);
    html += `<div class="sl-panel">
      <div style="padding:11px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f0f0f0">
        <span style="font-size:13px;font-weight:500;color:#333">\u{1F4CB} Starterliste</span>
        <span style="font-size:12px;color:${active ? '#2e7d32' : '#999'}">${active ? escH(active.name) : 'Keine aktiv'}</span>
      </div>`;
    startlistMeta.forEach(sl => {
      html += `<div class="sl-item">
        <div class="sl-dot" style="background:${sl.id === activeSlId ? '#4caf50' : '#ddd'}"></div>
        <span style="font-size:13px;color:#333;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escH(sl.name)}</span>
        <span style="font-size:11px;color:#aaa;flex-shrink:0">${sl.riderCount}</span>
        <button class="btn" data-action="activate-list" data-id="${sl.id}" style="padding:4px 8px;font-size:11px;flex-shrink:0">Aktiv</button>
        <button class="btn" data-action="delete-list"   data-id="${sl.id}" style="padding:4px 8px;font-size:11px;flex-shrink:0;color:#f44336">\u2715</button>
      </div>`;
    });
    html += `<div style="padding:10px 14px">
      <button class="btn" data-action="upload-startlist" style="width:100%">\u{1F4C2} Import</button>
    </div></div>`;
    html += `<div style="display:flex;gap:8px;margin-bottom:12px">
      <button class="btn" data-action="add-group" style="flex:1">\uFF0B Gruppe</button>
      <button class="btn" data-action="new-race"  style="flex:1;color:#f44336">\u{1F6A8} Neues Rennen</button>
    </div>`;
  }
  if (taktikGroups.length === 0) {
    html += `<div style="text-align:center;color:#bbb;padding:40px 20px;font-size:14px">
      ${authToken ? 'Noch keine Gruppen \u2013 oben auf \uFF0B Gruppe tippen' : 'Noch keine Gruppen angelegt'}
    </div>`;
  } else {
    taktikGroups.forEach((g, idx) => {
      const riders    = g.riders || [];
      const isLeading = idx === 0;
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
             style="font-size:14px;font-weight:500;border:none;background:transparent;color:#333;padding:0;width:145px;max-width:55vw">`
        : `<span style="font-size:14px;font-weight:500;color:#333">${escH(g.name)}</span>`;
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
        return `<div class="r-row">
          ${authToken ? `<button class="btn" data-action="remove-rider" data-gid="${g.id}" data-nr="${nr}"
            style="padding:1px 5px;font-size:11px;color:#f44336;min-width:unset;flex:0">\u2715</button>` : ''}
          <span class="r-nr">${nr}</span>
          <div style="flex:1">${r.name
            ? `<div class="r-name">${escH(r.name)}</div><div class="r-team">${escH(r.team||'')}</div>`
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
          </div>
          ${gapHtml}
        </div>
        ${riders.length > 0 ? `<div class="gc-sec">${riderRows}</div>` : ''}
        ${footer}
      </div>`;
    });
  }
  html += renderDisplayPanel();
  tkBody.innerHTML = html;
}

