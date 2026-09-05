// =====================================================================
// ZEITMESSUNG - Oberflaeche
// =====================================================================
// Zwei Aufgaben:
//   1. Einrichtung: Link je Veranstaltung, Kategorie je Rennen.
//   2. Im Rennen: Vorschlaege zeigen, uebernehmen oder behalten.
//
// Grundregel aus der Abstimmung: die Zeitmessung ueberschreibt nichts
// von allein. Sie schlaegt vor, uebernommen wird durch Tippen.

let timingCfg     = { ev: {}, rc: {}, stand: {}, lauf: {} };
let timingProp    = null;      // Vorschlag des gerade gezeigten Rennens
let timingSetupEv = null;      // Veranstaltung im Einrichtungsdialog
let timingKats    = [];        // gefundene Kategorien
let timingBusy    = false;
let bewegOffen    = false;     // Bewegungsliste auf- oder zugeklappt

const BEWEG_MAX = 40;

// ---------------------------------------------------------------------
// Bewegungen
// ---------------------------------------------------------------------
// Ersetzt das Durchstreichen ausgeschiedener Fahrer: nicht der Zustand
// zaehlt, sondern was seit dem letzten Blick passiert ist. Liegt im
// Geraet, nicht am Server - es ist eine Lesehilfe, kein Rennprotokoll.
function bewegKey(rid) { return 'lt_beweg_' + rid; }

function bewegLade(rid) {
  if (!rid) return [];
  try { return JSON.parse(localStorage.getItem(bewegKey(rid)) || '[]'); }
  catch { return []; }
}

function bewegSchreib(rid, liste) {
  if (!rid) return;
  try { localStorage.setItem(bewegKey(rid), JSON.stringify(liste.slice(0, BEWEG_MAX))); }
  catch { /* voller Speicher darf die Taktik nicht aufhalten */ }
}

function bewegAdd(rid, src, was, wo) {
  if (!rid || !was) return;
  const l = bewegLade(rid);
  const d = new Date();
  l.unshift({
    t: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    src, was, wo: wo || '', neu: true, ts: Date.now()
  });
  bewegSchreib(rid, l);
}

// Alles als gelesen markieren. Wird beim Aufklappen aufgerufen.
function bewegGelesen(rid) {
  const l = bewegLade(rid).map(e => ({ ...e, neu: false }));
  bewegSchreib(rid, l);
}

// Zwei Gruppenstaende vergleichen und daraus Saetze bauen. Bewusst nur
// Fahrerwechsel im Klartext; Abstaende wuerden jede Runde die Liste
// fluten und werden zu einer Zeile zusammengefasst.
function bewegAusDiff(alt, neu) {
  const wo = (gs, nr) => {
    const g = gs.find(x => (x.riders || []).some(r => Number(r.nr !== undefined ? r.nr : r) === nr));
    return g ? g.name : null;
  };
  const alleNrs = new Set();
  for (const gs of [alt, neu]) for (const g of gs) for (const r of (g.riders || []))
    alleNrs.add(Number(r.nr !== undefined ? r.nr : r));

  const saetze = [];
  for (const nr of alleNrs) {
    const a = wo(alt, nr), b = wo(neu, nr);
    if (a === b) continue;
    if (a && b)      saetze.push({ nr, wo: `${a} <i>&rarr;</i> ${b}` });
    else if (b)      saetze.push({ nr, wo: `neu in ${b}` });
    else if (a)      saetze.push({ nr, wo: `aus ${a} entfernt` });
  }
  const abst = neu.some((g, i) => alt[i] && (alt[i].gap || null) !== (g.gap || null));
  return { saetze, abst };
}

// Nach jeder uebernommenen oder eigenen Aenderung aufrufen.
function bewegBuchen(rid, alt, neu, src) {
  const d = bewegAusDiff(alt || [], neu || []);
  for (const s of d.saetze.slice(0, 6)) {
    const f = (typeof fahrerName === 'function') ? fahrerName(s.nr) : null;
    bewegAdd(rid, src, `${s.nr}${f ? ' ' + f : ''}`, s.wo);
  }
  if (d.abst && src === 'auto') {
    const txt = neu.filter(g => g.gap).map(g => `${g.name} ${g.gap}`).join(' \u00B7 ');
    bewegAdd(rid, src, 'Abst\u00E4nde aktualisiert', txt);
  }
}

// Fahrername aus der geladenen Startliste, wenn vorhanden.
function fahrerName(nr) {
  for (const g of (taktikGroups || [])) {
    for (const r of (g.riders || [])) {
      if (r && typeof r === 'object' && Number(r.nr) === Number(nr) && r.name) return r.name;
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------

async function loadTiming() {
  if (!authToken) return;
  try {
    const res = await fetch(`${SERVER}/timing`, { headers: { 'Authorization': `Bearer ${authToken}` } });
    if (!res.ok) return;
    timingCfg = await res.json();
  } catch (e) { console.error('Zeitmessung:', e); }
}

async function loadTimingProposal() {
  const rid = (typeof activeRaceId !== 'undefined' && activeRaceId) ? activeRaceId : null;
  if (!rid || !authToken) { timingProp = null; return; }
  try {
    const res = await fetch(`${SERVER}/timing/proposal?race=${encodeURIComponent(rid)}`,
      { headers: { 'Authorization': `Bearer ${authToken}` } });
    if (!res.ok) { timingProp = null; return; }
    const d = await res.json();
    timingProp = d && d.vorhanden ? d : null;
  } catch { timingProp = null; }
}

// ---------------------------------------------------------------------
// Anzeige in der Taktik
// ---------------------------------------------------------------------

function timingAktivFuer(rid) {
  return !!(rid && timingCfg.rc && timingCfg.rc[rid] && timingCfg.rc[rid].an !== false);
}

// Kopfzeile: verbunden, Stand, oder stumm.
function timingStatusText(rid) {
  if (!timingAktivFuer(rid)) return null;
  if (timingCfg.lauf && timingCfg.lauf.abgeschaltet) return { t: 'Zeitmessung abgeschaltet', f: '#ff9800' };
  if (!timingProp) return { t: 'Zeitmessung antwortet nicht', f: '#ff9800' };
  const d = new Date(timingProp.ts);
  return { t: `Stand ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`,
           f: '#4caf50' };
}

// Der Balken. Kein Dialog: ein Fenster mitten im Rennen verdeckt genau
// die Gruppen, ueber die entschieden werden soll.
function timingBanner() {
  if (!authToken || !timingProp || !timingProp.gruppen || !timingProp.gruppen.length) return '';
  const n = timingProp.gruppen.length;
  const d = new Date(timingProp.ts);
  const uhr = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  const meta = `${timingProp.live ? 'Liveliste' : 'Ergebnisliste'} \u00B7 ${uhr} \u00B7 `
             + `${n} ${n === 1 ? 'Gruppe' : 'Gruppen'}, ${timingProp.gruppen.reduce((s,g)=>s+g.riders.length,0)} Fahrer`;
  return `<div class="zmBar">
    <div class="zm-ttl">\u23F1 Neuer Stand</div>
    <div class="zm-meta">${escH(meta)}</div>
    ${timingProp.hinweis ? `<div class="zm-warn">\u26A0\uFE0F ${escH(timingProp.hinweis)}</div>` : ''}
    ${zmAusgelassen()}
    <div class="zm-acts">
      <button class="btn zm-prim" data-action="timing-apply-all">\u00DCbernehmen</button>
      <button class="btn" data-action="timing-dismiss">Verwerfen</button>
    </div>
  </div>`;
}

// Nummern, die es nicht in den Vorschlag geschafft haben. Bis 2.9.x
// wurden sie stillschweigend geschluckt - wer im Auto eine Nummer
// vermisst, soll nicht raten muessen, warum sie fehlt.
// Zwei Quellen: ausgelassen (nicht im Rennen oder DSQ/DNF, aussortiert
// vom Server) und verworfen (unglaubwuerdige Messstelle, aussortiert in
// zuGruppen). Beides wird knapp gehalten - der Balken ist kein Bericht.
function zmAusgelassen() {
  const aus = Array.isArray(timingProp.ausgelassen) ? timingProp.ausgelassen : [];
  const vw  = Array.isArray(timingProp.verworfen)   ? timingProp.verworfen   : [];
  if (aus.length === 0 && vw.length === 0) return '';
  const teile = [];
  if (aus.length) {
    const nrs = aus.slice(0, 8).map(e => e.nr).join(', ');
    teile.push(`${aus.length} nicht gewertet (${nrs}${aus.length > 8 ? ' \u2026' : ''})`);
  }
  if (vw.length) {
    const nrs = vw.slice(0, 8).map(e => e.nr).join(', ');
    teile.push(`${vw.length} unglaubw\u00FCrdig (${nrs}${vw.length > 8 ? ' \u2026' : ''})`);
  }
  return `<div class="zm-aus">\u2298 ${escH(teile.join(' \u00B7 '))}</div>`;
}

// Herkunftsmarke im Gruppenkopf.
function timingSrcBadge(g) {
  if (!timingAktivFuer(activeRaceId)) return '';
  return g && g.src === 'auto'
    ? '<span class="zm-src auto" title="Zuletzt aus der Zeitmessung \u00FCbernommen">\u23F1</span>'
    : '<span class="zm-src hand" title="Von Hand gesetzt">\u270E</span>';
}

// Aufklappbare Bewegungsliste am Ende der Taktik.
function timingBewegungen() {
  const rid = (typeof activeRaceId !== 'undefined') ? activeRaceId : null;
  if (!rid) return '';
  const liste = bewegLade(rid);
  const neu   = liste.filter(e => e.neu).length;
  const zeig  = liste.slice(0, 5);
  const rows  = liste.length === 0
    ? '<div class="bw-leer">Noch keine Bewegungen in diesem Rennen</div>'
    : zeig.map(e => `<div class="bw${e.neu ? ' neu' : ''}">
        <span class="bw-src ${e.src === 'auto' ? 'auto' : 'hand'}">${e.src === 'auto' ? '\u23F1' : '\u270E'}</span>
        <span class="bw-t">${escH(e.t)}</span>
        <div style="flex:1;min-width:0">
          <div class="bw-w">${escH(e.was)}</div>
          <div class="bw-p">${e.wo}</div>
        </div></div>`).join('')
      + (liste.length > 5 ? `<div class="bw-mehr">${liste.length - 5} \u00E4ltere</div>` : '');
  return `<div class="bwBox${bewegOffen ? ' on' : ''}">
    <button class="bw-hdr" data-action="beweg-toggle" aria-expanded="${bewegOffen}">
      <b>Bewegungen</b>
      ${neu ? `<span class="bw-neu">${neu} neu</span>` : `<span class="bw-cnt">${liste.length}</span>`}
      <span class="bw-chev">\u25BC</span>
    </button>
    <div class="bw-body">${rows}</div>
  </div>`;
}

// ---------------------------------------------------------------------
// Hauptfeld-Vorschlag nach einem Import
// ---------------------------------------------------------------------
// applyVorschlag() im Server ordnet die neuen Gruppen positionsweise auf
// den Bestand: der HF-Marker bleibt am Index haengen, nicht an der
// Gruppe. Kommen aus der Zeitmessung mehr oder weniger Gruppen als
// vorher, steht er danach an der falschen Stelle - und auf dem Garmin
// endet der Text am HF, der Fehler wirkt also bis ins Auto durch.
//
// Umgesetzt wird nichts von allein; das waere gegen die Grundregel der
// Zeitmessung und im Gruppetto oft auch falsch. Stattdessen faerbt sich
// der ohnehin vorhandene graue HF-Knopf der groessten Gruppe.
const HF_VORSPRUNG = 2;        // Mindestabstand in Fahrern, sonst kein Vorschlag
let   hfVorschlagGid = null;   // Gruppe, deren HF-Knopf gerade faerbt

function hfVorschlagLoeschen() { hfVorschlagGid = null; }

// Gruppengroesse ohne DSQ/DNF - wie aktivZahl() in race/taktik-ui.js.
// Eigene Fassung, weil /timing/apply die Fahrer als reine Nummern
// zurueckgibt (sanitizeGroups streift den Zustand ab). Der Zustand kommt
// dann aus dem Stand vor dem Import, uebergeben in "zust".
function hfZahl(g, zust) {
  return ((g && g.riders) || []).filter(r => {
    const nr = (r && r.nr !== undefined) ? r.nr : r;
    const st = (r && r.status) || (zust ? zust[nr] : null);
    return !(st === 'dsq' || st === 'dnf');
  }).length;
}

// Zustaende aus dem Stand vor dem Import, nach Startnummer.
function hfZustaende(gruppen) {
  const zust = {};
  (gruppen || []).forEach(g => ((g && g.riders) || []).forEach(r => {
    if (r && r.nr !== undefined && r.status) zust[r.nr] = r.status;
  }));
  return zust;
}

// Liefert { gid, name, zahl } oder null. Kein Vorschlag, wenn:
//   - weniger als zwei Gruppen da sind
//   - zwei Gruppen gleich gross sind (kein eindeutiges Groesstes)
//   - die groesste Gruppe schon das Hauptfeld ist
//   - ihr Vorsprung kleiner als HF_VORSPRUNG ist (12 gegen 11 ist kein Grund)
// Welche Gruppe als Hauptfeld gilt, wird wie in mainGroupIdx() und im
// Server bestimmt: ausdruecklicher main-Marker, sonst die letzte Gruppe.
function hfVorschlagRechne(gruppen, zust) {
  const list = Array.isArray(gruppen) ? gruppen.filter(Boolean) : [];
  if (list.length < 2) return null;
  const zahlen = list.map(g => hfZahl(g, zust));
  let max = -1, maxIdx = -1, doppelt = false;
  zahlen.forEach((z, i) => {
    if (z > max)       { max = z; maxIdx = i; doppelt = false; }
    else if (z === max) doppelt = true;
  });
  if (maxIdx < 0 || doppelt || max <= 0) return null;
  const mIdx = list.findIndex(g => g.main === true);
  const hfIdx = mIdx >= 0 ? mIdx : list.length - 1;
  if (maxIdx === hfIdx) return null;
  if (max - zahlen[hfIdx] < HF_VORSPRUNG) return null;
  return { gid: list[maxIdx].id, name: list[maxIdx].name || 'Gruppe', zahl: max };
}

// Frage der Oberflaeche: faerbt der HF-Knopf dieser Gruppe? Der Vorschlag
// wird dabei jedes Mal neu gerechnet - wandern zwischendurch Fahrer,
// verschwindet er still, statt auf eine ueberholte Lage zu zeigen.
function hfVorschlagFuer(gid) {
  if (!authToken || !hfVorschlagGid || hfVorschlagGid !== gid) return false;
  const v = hfVorschlagRechne(taktikGroups, null);
  return !!(v && v.gid === gid);
}

// ---------------------------------------------------------------------
// Aktionen im Rennen
// ---------------------------------------------------------------------

async function timingApply(gid) {
  if (!authToken || !activeRaceId || timingBusy) return;
  timingBusy = true;
  const alt = JSON.parse(JSON.stringify(taktikGroups || []));
  try {
    const res = await fetch(`${SERVER}/timing/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ race: activeRaceId, group: gid || null })
    });
    if (!res.ok) { checkAuth(res); showToast('\u26A0\uFE0F Nicht \u00FCbernommen'); return; }
    const d = await res.json();
    // Der Server hat geschrieben - lokalen Stand nachziehen, sonst
    // ueberschreibt der naechste Poll die Anzeige erst in fuenf Sekunden.
    taktikGroups = (d.groups || []).map(g => ({ ...g, src: 'auto' }));
    bewegBuchen(activeRaceId, alt, taktikGroups, 'auto');
    timingProp = null;
    // Steht der HF-Marker nach dem Import noch richtig? Der Zustand der
    // Fahrer kommt aus "alt", weil die Antwort nur Nummern enthaelt.
    const vor = hfVorschlagRechne(taktikGroups, hfZustaende(alt));
    hfVorschlagGid = vor ? vor.gid : null;
    renderTaktikBody(); renderStrip(taktikGroups);
    showToast('\u23F1 \u00DCbernommen' + (vor
      ? ' \u00B7 gr\u00F6\u00DFte Gruppe: ' + String(vor.name).slice(0, 14) + ' (' + vor.zahl + ')'
      : ''));
  } catch (e) { showToast('\u26A0\uFE0F ' + e.message); }
  finally { timingBusy = false; }
}

async function timingDismiss() {
  if (!authToken || !activeRaceId) return;
  try {
    await fetch(`${SERVER}/timing/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ race: activeRaceId })
    });
  } catch { /* stiller Fehlschlag: der naechste Abruf meldet sich neu */ }
  timingProp = null;
  renderTaktikBody();
}

// ---------------------------------------------------------------------
// Einrichtung
// ---------------------------------------------------------------------

function openTimingSetup(eventId) {
  timingSetupEv = eventId;
  timingKats    = [];
  const m = document.getElementById('timingModal');
  if (!m) return;
  const vorh = (timingCfg.ev && timingCfg.ev[eventId]) ? timingCfg.ev[eventId] : null;
  document.getElementById('tmLink').value = vorh
    ? `https://my.raceresult.com/${vorh.eventId}/participants` : '';
  document.getElementById('tmStatus').textContent = '';
  document.getElementById('tmBody').innerHTML = '';
  m.classList.remove('hidden');
  setTimeout(() => document.getElementById('tmLink').focus(), 30);
}

function closeTimingSetup() {
  const m = document.getElementById('timingModal');
  if (m) m.classList.add('hidden');
  timingSetupEv = null;
}

async function timingProbe() {
  const link = document.getElementById('tmLink').value.trim();
  const st   = document.getElementById('tmStatus');
  if (!link) { st.textContent = 'Bitte den Link der Veranstaltung einf\u00FCgen.'; return; }
  st.textContent = '\u23F1 Veranstaltung wird gelesen \u2013 das dauert einige Sekunden\u2026';
  document.getElementById('tmBody').innerHTML = '';
  try {
    const res = await fetch(`${SERVER}/timing/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ link, event: timingSetupEv })
    });
    const d = await res.json();
    if (!res.ok) { st.textContent = '\u274C ' + (d.error || res.status); return; }
    timingKats = d.kategorien || [];
    st.textContent = '';
    renderTimingSetup(d);
  } catch (e) { st.textContent = '\u274C ' + e.message; }
}

function renderTimingSetup(d) {
  const rennen = (typeof eventList !== 'undefined' && Array.isArray(eventList))
    ? (eventList.find(e => e.id === timingSetupEv) || {}).races || [] : [];
  const rc = timingCfg.rc || {};
  const zeilen = timingKats.map(k => {
    const gew = Object.keys(rc).find(rid => String(rc[rid].contest) === String(k.contest)
                                        && rennen.some(r => r.id === rid));
    const vor = k.vorschlag ? k.vorschlag.id : '';
    const sel = gew || vor || '';
    const opt = ['<option value="">\u2014 nicht nutzen</option>']
      .concat(rennen.map(r =>
        `<option value="${escH(r.id)}"${r.id === sel ? ' selected' : ''}>${escH(r.name)}</option>`))
      .concat([`<option value="__neu">+ Rennen anlegen</option>`]).join('');
    const merk = [];
    if (k.fahrer)      merk.push(`${k.fahrer} Fahrer`);
    if (k.hatErgebnis) merk.push('Ergebnisliste');
    if (!k.hatStart && !k.hatErgebnis) merk.push('keine Liste');
    return `<div class="tm-row">
      <div class="tm-kat">
        <div class="tm-name">${escH(k.name)}</div>
        <div class="tm-merk">${escH(merk.join(' \u00B7 '))}${
          k.vorschlag && !gew ? ` \u00B7 Vorschlag` : ''}</div>
      </div>
      <select class="tm-sel" data-contest="${escH(k.contest)}">${opt}</select>
    </div>`;
  }).join('');
  document.getElementById('tmBody').innerHTML = `
    <div class="tm-ev" data-eventid="${escH(d.eventId)}">${escH(d.eventname || '')}<span>Nr. ${escH(d.eventId)}</span></div>
    ${zeilen || '<div class="bw-leer">Keine Kategorien gefunden</div>'}
    <div class="tm-foot">
      <button class="btn" data-action="timing-save">Zuordnung speichern</button>
      <button class="btn" data-action="timing-startlists">Startlisten holen</button>
    </div>`;
}

function timingAuswahl() {
  const out = {};
  document.querySelectorAll('#tmBody .tm-sel').forEach(s => {
    if (s.value && s.value !== '__neu') out[s.value] = { contest: s.dataset.contest };
  });
  return out;
}

async function timingSave(still) {
  const ev = document.getElementById('tmBody').querySelector('.tm-ev');
  const eventId = ev ? ev.dataset.eventid : null;
  const zuordnung = timingAuswahl();
  try {
    const res = await fetch(`${SERVER}/timing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ event: timingSetupEv, eventId, zuordnung })
    });
    if (!res.ok) { document.getElementById('tmStatus').textContent = '\u274C Nicht gespeichert'; return false; }
    await loadTiming();
    if (!still) { document.getElementById('tmStatus').textContent = '\u2705 Zuordnung gespeichert'; }
    return true;
  } catch (e) { document.getElementById('tmStatus').textContent = '\u274C ' + e.message; return false; }
}

async function timingStartlists() {
  const st = document.getElementById('tmStatus');
  if (!await timingSave(true)) return;
  const paare = Object.entries(timingAuswahl());
  if (!paare.length) { st.textContent = 'Erst eine Kategorie zuordnen.'; return; }
  let ok = 0, fehl = 0;
  for (const [rid, v] of paare) {
    st.textContent = `\u23F1 Startliste ${ok + fehl + 1} von ${paare.length}\u2026`;
    try {
      const res = await fetch(`${SERVER}/timing/startlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ event: timingSetupEv, contest: v.contest, race: rid })
      });
      if (res.ok) ok++; else fehl++;
    } catch { fehl++; }
  }
  st.textContent = `\u2705 ${ok} Startliste${ok === 1 ? '' : 'n'} \u00FCbernommen`
                 + (fehl ? ` \u00B7 ${fehl} fehlgeschlagen` : '');
  if (typeof loadEvents === 'function') { await loadEvents(); renderEventsBody(); }
}

// ---------------------------------------------------------------------
// Verdrahtung
// ---------------------------------------------------------------------

document.addEventListener('click', function (ev) {
  const b = ev.target.closest('[data-action]');
  if (!b) return;
  switch (b.dataset.action) {
    case 'timing-apply-all':  timingApply(null); break;
    case 'timing-apply':      timingApply(b.dataset.gid); break;
    case 'timing-dismiss':    timingDismiss(); break;
    case 'timing-probe':      timingProbe(); break;
    case 'timing-save':       timingSave(false); break;
    case 'timing-startlists': timingStartlists(); break;
    case 'timing-close':      closeTimingSetup(); break;
    case 'beweg-toggle':
      bewegOffen = !bewegOffen;
      if (bewegOffen) bewegGelesen(activeRaceId);
      renderTaktikBody();
      break;
    default: return;
  }
});

// Im selben Takt wie pollGroups(). Neu gezeichnet wird nur, wenn sich
// wirklich etwas geaendert hat - sonst flackert bei jedem Durchlauf
// jedes Eingabefeld in der Taktik.
let timingLetzterStempel = null;

async function pollTiming() {
  if (!authToken) return;
  const vorher = timingLetzterStempel;
  await loadTimingProposal();
  timingLetzterStempel = timingProp ? timingProp.ts : null;
  if (timingLetzterStempel !== vorher && typeof taktikOpen !== 'undefined' && taktikOpen) {
    renderTaktikBody();
  }
}
