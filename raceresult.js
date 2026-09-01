// =====================================================================
// ZEITMESSUNG (my.raceresult.com)
// =====================================================================
// Liest oeffentlich veroeffentlichte Listen einer Veranstaltung.
// Bewusst ohne Express-Bezug: das Modul laesst sich damit isoliert
// gegen den echten Dienst testen, ohne den Server zu starten.
//
// Der Weg ist nicht dokumentiert. Er ist derselbe, den die
// Ergebnisseite im Browser benutzt, und kann sich jederzeit aendern -
// deshalb faengt jede Funktion ihre Fehler selbst ab und liefert im
// Zweifel eine leere Antwort statt einer Ausnahme. Faellt die
// Zeitmessung aus, laeuft die Taktik von Hand weiter.
//
// Beobachtet am 01.09.2026 an Event 409896:
//   * Pfad ist /{EventID}/{TAB}/config bzw. .../list - TAB ist der vom
//     Zeitnehmer frei vergebene Reitername, kein fester Bestandteil.
//   * config nennt teils einen anderen Host (Feld "server").
//   * /list antwortet mit 301; Weiterleitungen muessen verfolgt werden.
//   * Listennamen aendern sich waehrend der Vorbereitung. Zwischen zwei
//     Abrufen im Abstand von Minuten wurde aus
//     "…Road Race Start List_ohne Startzeit" schlicht
//     "…Road Race Start List". Namen werden daher NIE zwischengespeichert,
//     sondern vor jedem Abruf frisch aus der config gelesen.
//   * Nicht jede in der config genannte Liste ist auch abrufbar.

const BASIS_HOST = 'my.raceresult.com';
const TIMEOUT_MS = 12000;

// Reiter, die es zu probieren lohnt, wenn die Startseite nichts hergibt.
const TAB_KANDIDATEN = [
  'results', 'participants', 'live', 'ergebnisse', 'teilnehmer',
  'startlisten', 'startlist', 'leaderboard', 'timing', 'zwischenzeiten'
];

// ---------------------------------------------------------------------
// Netz
// ---------------------------------------------------------------------

// Ein Abruf mit harter Zeitgrenze. Ohne die haengt der Poller bei einem
// stummen Server bis zum Sankt-Nimmerleins-Tag - und mit ihm der
// Intervall, der ihn gestartet hat.
async function hole(url, alsText) {
  const ab = new AbortController();
  const t  = setTimeout(() => ab.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal:   ab.signal,
      redirect: 'follow',
      headers:  { 'Accept': alsText ? 'text/html' : 'application/json' }
    });
    if (!res.ok) return { fehler: `HTTP ${res.status}` };
    if (alsText) return { text: await res.text() };
    const roh = await res.text();
    try   { return { daten: JSON.parse(roh) }; }
    catch { return { fehler: 'keine JSON-Antwort' }; }
  } catch (e) {
    return { fehler: e.name === 'AbortError' ? 'Zeitueberschreitung' : e.message };
  } finally { clearTimeout(t); }
}

function istEventId(v) { return /^[0-9]{4,9}$/.test(String(v || '').trim()); }

// Aus einem Link die Event-Nummer ziehen. Der Anwender kopiert die
// Adresse aus dem Browser, nicht die nackte Zahl.
function eventIdAus(eingabe) {
  const s = String(eingabe || '').trim();
  if (istEventId(s)) return s;
  const m = s.match(/(?:raceresult\.com)\/([0-9]{4,9})(?:[/#?]|$)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------
// Config und Listen
// ---------------------------------------------------------------------

async function holeConfig(eventId, tab, host) {
  const h = host || BASIS_HOST;
  const r = await hole(`https://${h}/${eventId}/${encodeURIComponent(tab)}/config?lang=de`);
  if (r.fehler) return { fehler: r.fehler };
  const d = r.daten;
  if (!d || d.error || !d.key) return { fehler: (d && d.error) || 'kein Schluessel' };
  // Listen stehen je nach Reitertyp an zwei Stellen.
  const listen = (d.TabConfig && Array.isArray(d.TabConfig.Lists)) ? d.TabConfig.Lists
               : (Array.isArray(d.lists) ? d.lists : []);
  return {
    key:       d.key,
    eventname: d.eventname || '',
    contests:  d.contests || {},
    server:    d.server || null,
    eventOver: d.EventOver === true,
    listen:    listen.map(l => ({
      contest: String(l.Contest === undefined || l.Contest === null ? '' : l.Contest),
      name:    String(l.Name || ''),
      zeigeAls: String(l.ShowAs || l.Name || ''),
      live:    !!l.Live
    })).filter(l => l.name)
  };
}

async function holeListe(eventId, tab, key, listname, contest, host) {
  const h = host || BASIS_HOST;
  const url = `https://${h}/${eventId}/${encodeURIComponent(tab)}/list`
            + `?key=${encodeURIComponent(key)}`
            + `&listname=${encodeURIComponent(listname)}`
            + `&page=${encodeURIComponent(tab)}`
            + `&contest=${encodeURIComponent(contest === undefined ? 0 : contest)}`
            + `&r=all&l=0`;
  const r = await hole(url);
  if (r.fehler) return { fehler: r.fehler };
  const d = r.daten;
  if (!d || d.error) return { fehler: (d && d.error) || 'leere Antwort' };
  if (!Array.isArray(d.DataFields)) return { fehler: 'Antwort ohne Spalten' };
  return {
    spalten:  d.DataFields,
    felder:   (d.list && Array.isArray(d.list.Fields)) ? d.list.Fields : [],
    zeilen:   flachZeilen(d.data),
    intervall: (typeof d.LiveUpdateInterval === 'number' && d.LiveUpdateInterval > 0)
                 ? d.LiveUpdateInterval : null
  };
}

// data ist eine Liste von Zeilen - oder, sobald der Zeitnehmer eine
// Gruppierung eingestellt hat, ein Objekt aus solchen Listen. Beides
// kommt vor, also wird beides flachgezogen.
function flachZeilen(data) {
  if (Array.isArray(data)) return data.filter(Array.isArray);
  if (data && typeof data === 'object') {
    const out = [];
    for (const v of Object.values(data)) {
      if (Array.isArray(v)) for (const z of v) if (Array.isArray(z)) out.push(z);
    }
    return out;
  }
  return [];
}

// ---------------------------------------------------------------------
// Erkundung: welche Reiter, welche Rennen, welche Listen
// ---------------------------------------------------------------------

// Die Startseite nennt ihre Reiter selbst. Das ist verlaesslicher als
// Raten - geraten wird nur, wenn nichts dabei herauskommt.
async function tabsAusSeite(eventId) {
  const r = await hole(`https://${BASIS_HOST}/${eventId}/`, true);
  if (r.fehler || !r.text) return [];
  const gefunden = new Set();
  const re = new RegExp(`href="/${eventId}/([a-zA-Z0-9_-]{2,40})"`, 'g');
  let m;
  while ((m = re.exec(r.text)) !== null) {
    const t = m[1].toLowerCase();
    if (t !== 'contact' && t !== 'kontakt') gefunden.add(m[1]);
  }
  return [...gefunden];
}

// Vollstaendige Erkundung. Liefert je Reiter die Listen, die sich
// wirklich abrufen liessen - eine in der config genannte Liste, die
// 404 antwortet, waere am Renntag eine boese Ueberraschung.
async function erkunde(eingabe) {
  const eventId = eventIdAus(eingabe);
  if (!eventId) return { fehler: 'Keine Event-Nummer im Link gefunden' };

  const ausSeite = await tabsAusSeite(eventId);
  const zuPruefen = [...new Set([...ausSeite, ...TAB_KANDIDATEN])];

  let eventname = '', contests = {}, host = null;
  const reiter = [];

  for (const tab of zuPruefen) {
    const cfg = await holeConfig(eventId, tab, host);
    if (cfg.fehler) continue;
    if (!eventname) eventname = cfg.eventname;
    if (cfg.server && !host) host = cfg.server;
    for (const [k, v] of Object.entries(cfg.contests || {})) contests[k] = v;

    // Jede Liste einmal wirklich anfassen.
    const listen = [];
    for (const l of cfg.listen) {
      const res = await holeListe(eventId, tab, cfg.key, l.name, l.contest || 0, host);
      listen.push({
        contest:  l.contest,
        name:     l.name,
        zeigeAls: l.zeigeAls,
        live:     l.live,
        abrufbar: !res.fehler,
        zeilen:   res.fehler ? 0 : res.zeilen.length,
        art:      res.fehler ? null : artDerListe(res),
        fehler:   res.fehler || null
      });
    }
    reiter.push({ tab, listen });
  }

  if (reiter.length === 0) {
    return { fehler: 'Keine oeffentlichen Listen gefunden. Ist die Veranstaltung schon freigegeben?' };
  }
  return { eventId, eventname, contests, host, reiter };
}

// ---------------------------------------------------------------------
// Spaltenzuordnung
// ---------------------------------------------------------------------
// Der Zeitnehmer baut seine Listen frei zusammen, und er verpackt die
// Ausdruecke in Bedingungen. Aus Event 409896:
//
//   if([SELECTORID]<>[TTT_StageID];[DisplayBib])
//   switch(...;GapTimeTop(...);...)
//
// Ein Gleichheitsvergleich auf den Ausdruck greift dort nie. Gesucht
// wird deshalb nach enthaltenen Bezeichnern - und zuerst ueber die
// Beschriftung der Spalte, denn die sagt, was der Zeitnehmer gemeint
// hat: "Pl." | "Startnr." | "Name" | "Team" | "Zeit".
//
// Jeder Index wird hoechstens einmal vergeben. Ohne das landeten "Zeit"
// und "Rueckstand" auf derselben Spalte, weil ein einziger
// switch()-Ausdruck beide Faelle abdeckt.

// Beschriftung -> Rolle. Wird zuerst ausgewertet.
const LABEL = {
  platz:  ['pl.', 'pl', 'platz', 'rang', 'rank', 'position'],
  bibKurz:['startnr.', 'startnr', 'startnummer', 'nr.', 'nr', 'bib'],
  name:   ['name', 'fahrer', 'teilnehmer'],
  team:   ['team', 'verein', 'mannschaft', 'club'],
  jahr:   ['jahrg.', 'jahrg', 'jahrgang', 'jg'],
  nation: ['nation', 'land'],
  zeit:   ['zeit', 'time', 'endzeit'],
  rueck:  ['rückstand', 'ruckstand', 'abstand', 'gap', 'diff', '+/-']
};

// Bezeichner im Ausdruck -> Rolle. Rueckfallebene.
const MUSTER = {
  bib:    [/^BIB$/],
  bibKurz:[/\[?DisplayBib\]?/i],
  name:   [/\[?DisplayName\]?/i, /\[?LASTNAME\]?/i],
  team:   [/\[?DisplayClub\]?/i, /\[?CLUB\]?/i, /\[?TEAM(\.NAME)?\]?/i],
  jahr:   [/\[?YEAR\]?/i, /\[?JAHRGANG\]?/i],
  nation: [/NATION\.IOCNAME/i],
  platz:  [/StageRank/i, /DisplayPlace/i, /\bRank\(/i, /^RANK\d?$/i],
  zeit:   [/TTDisplayTime/i, /StageTime/i, /^TIMETEXT$/i, /ChipTime/i, /GunTime/i],
  rueck:  [/GapTimeTop/i, /GapTime/i]
};

// Reihenfolge der Vergabe. Die eindeutigen Rollen zuerst, damit sie
// nicht von einer unschaerferen weggeschnappt werden.
const ROLLEN = ['bib', 'bibKurz', 'platz', 'name', 'team', 'jahr', 'nation', 'zeit', 'rueck'];

function zuordnung(res) {
  const sp   = res.spalten || [];
  const idx  = {};
  const belegt = new Set();

  const setze = (rolle, i) => {
    if (i < 0 || idx[rolle] !== undefined || belegt.has(i)) return false;
    idx[rolle] = i; belegt.add(i); return true;
  };

  // 1. Ueber die Beschriftung. felder[] und spalten[] sind nicht gleich
  //    lang, verbunden werden sie ueber den Ausdruck.
  for (const f of (res.felder || [])) {
    const lbl = String(f.Label || '').trim().toLowerCase();
    if (!lbl) continue;
    const i = sp.indexOf(f.Expression);
    if (i < 0) continue;
    for (const rolle of ROLLEN) {
      const worte = LABEL[rolle];
      if (!worte) continue;
      if (worte.includes(lbl)) { setze(rolle, i); break; }
    }
  }

  // 2. Ueber die Bezeichner im Ausdruck.
  for (const rolle of ROLLEN) {
    if (idx[rolle] !== undefined) continue;
    for (const reg of (MUSTER[rolle] || [])) {
      const i = sp.findIndex((s, k) => !belegt.has(k) && reg.test(String(s)));
      if (setze(rolle, i)) break;
    }
  }
  return idx;
}

// race|result setzt Auszeichnungen wie [img:...] oder [b] direkt in die
// Zellen. Unbereinigt landet das im Fahrernamen.
function sauber(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/\[img:[^\]]*\]/gi, '')
    .replace(/\[\/?[a-z][^\]]{0,40}\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function artDerListe(res) {
  const i = zuordnung(res);
  if (i.platz !== undefined || i.zeit !== undefined) return 'ergebnis';
  if (i.name !== undefined) return 'startliste';
  return null;
}

// ---------------------------------------------------------------------
// Fahrer und Ergebnisse
// ---------------------------------------------------------------------

// Startnummern: angezeigt wird die volle Nummer (BIB, z. B. 4001),
// verglichen wird zusaetzlich gegen die kurze (DisplayBib, z. B. 1).
// Welche von beiden in einer bestehenden Startliste steht, ist von
// Veranstaltung zu Veranstaltung verschieden.
function alsFahrer(res) {
  const i = zuordnung(res);
  const out = [];
  for (const z of res.zeilen) {
    const voll = i.bib     !== undefined ? sauber(z[i.bib])     : '';
    const kurz = i.bibKurz !== undefined ? sauber(z[i.bibKurz]) : '';
    const nr   = Number(voll || kurz);
    if (!Number.isFinite(nr) || nr <= 0) continue;
    const f = {
      nr,
      name: i.name !== undefined ? sauber(z[i.name]) : '',
      team: i.team !== undefined ? sauber(z[i.team]) : ''
    };
    const k = Number(kurz);
    if (Number.isFinite(k) && k > 0 && k !== nr) f.nrKurz = k;
    if (i.jahr   !== undefined) { const j = Number(sauber(z[i.jahr])); if (j > 1900) f.jahrgang = j; }
    if (i.nation !== undefined) { const n = sauber(z[i.nation]); if (n) f.nation = n; }
    if (f.name) out.push(f);
  }
  return out;
}

function alsErgebnis(res) {
  const i = zuordnung(res);
  const out = [];
  for (const z of res.zeilen) {
    const voll = i.bib     !== undefined ? sauber(z[i.bib])     : '';
    const kurz = i.bibKurz !== undefined ? sauber(z[i.bibKurz]) : '';
    const nr   = Number(voll || kurz);
    if (!Number.isFinite(nr) || nr <= 0) continue;
    const e = {
      nr,
      name:  i.name  !== undefined ? sauber(z[i.name]) : '',
      zeit:  i.zeit  !== undefined ? sauber(z[i.zeit]) : '',
      rueck: i.rueck !== undefined ? sauber(z[i.rueck]) : '',
      platz: i.platz !== undefined ? Number(String(sauber(z[i.platz])).replace(/\D/g, '')) : null
    };
    const k = Number(kurz);
    if (Number.isFinite(k) && k > 0 && k !== nr) e.nrKurz = k;
    if (!e.zeit && !e.rueck) continue;   // ohne Zeit keine Gruppe
    out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------
// Zeiten
// ---------------------------------------------------------------------

// "1:23:45.6", "12:34", "+0:48", "0:00:48" -> Sekunden.
//
// Dazu die Schreibweise, die race|result bei Radrennen ausgibt:
// H\hMM'Ss''kk, also 16'45''41 fuer 16 Minuten 45,41 Sekunden und
// 1h02'05''41 fuer eine gute Stunde. Am 01.09.2026 an Event 409896 im
// Feld gesehen - ohne diesen Zweig kam aus jeder Ergebnisliste eine
// leere Gruppenliste zurueck.
function zuSekunden(txt) {
  let s = String(txt || '').trim().replace(/^[+\-]/, '');
  if (!s || /^-+$/.test(s)) return null;
  // Reihenfolge zwingend: '' vor ', sonst wird aus 45''41 erst 45:'41.
  if (s.indexOf("'") >= 0 || /\d\s*h/i.test(s)) {
    s = s.replace(/\s+/g, '')
         .replace(/h/gi, ':')
         .replace(/''/g, '.')
         .replace(/'/g, ':')
         .replace(/:$/, '')
         .replace(/\.$/, '');
  }
  const teile = s.split(':').map(t => t.trim());
  if (teile.some(t => !/^\d+(\.\d+)?$/.test(t))) return null;
  let sek = 0;
  for (const t of teile) sek = sek * 60 + parseFloat(t);
  return Number.isFinite(sek) ? sek : null;
}

function ausSekunden(sek) {
  const g = Math.max(0, Math.round(sek));
  const m = Math.floor(g / 60), s = g % 60;
  if (m < 60) return `${m}:${String(s).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------
// Gruppenbildung
// ---------------------------------------------------------------------
// Zwei Regeln, in dieser Reihenfolge:
//
// 1. Gleiche Zeit = eine Gruppe. Im Strassenrennen bekommt jede Gruppe
//    dieselbe Zeit zugeschrieben; die Zeitnehmung rechnet das selbst
//    (race|result kennt dafuer BunchRank/BunchColor). Wo das greift,
//    ist es exakt und braucht keine Schwelle.
//
// 2. Schwelle in Sekunden, wenn die Zeiten fahrerscharf sind. Wer
//    innerhalb der Schwelle zum Vordermann liegt, gehoert zu dessen
//    Gruppe.
//
// Der Abstand einer Gruppe ist immer der zur Spitze - so wird er in der
// Taktik auch von Hand eingetragen.
//
// Rueckgabe: { modus, gruppen }. Der Modus gehoert mit ausgeliefert:
// steht dort 'schwelle', waren die Zeiten fahrerscharf - bei einem
// Einzelzeitfahren kommt dann eine formal richtige, sachlich sinnlose
// Gruppeneinteilung heraus, und die Oberflaeche muss das sagen duerfen.
function zuGruppen(eintraege, optionen) {
  const opt      = optionen || {};
  const schwelle = (typeof opt.schwelle === 'number' && opt.schwelle > 0) ? opt.schwelle : 3;
  const erzwinge = opt.modus === 'schwelle';

  // Die Zeitspalte wird EINMAL fuer die ganze Liste gewaehlt, nicht je
  // Fahrer. Am 01.09.2026 an Event 409896 aufgefallen: der Fuehrende
  // hat als Rueckstand "-" stehen, alle anderen "+2''75". Fahrerweise
  // entschieden bekam er seine Absolutzeit (1005 s) und die uebrigen
  // ihren Rueckstand (2 s) - der Erste sortierte sich damit ans Ende
  // des Feldes und verschwand aus der Spitzengruppe.
  const rueckOk = eintraege.filter(e => zuSekunden(e.rueck) !== null).length;
  const nutzeRueck = rueckOk >= Math.max(2, eintraege.length * 0.5);

  const mitZeit = [];
  for (const e of eintraege) {
    let sek, roh;
    if (nutzeRueck) {
      const r = zuSekunden(e.rueck);
      // "-" beim Fuehrenden heisst Rueckstand null, nicht "unbekannt".
      const istSpitze = r === null && /^\s*-+\s*$/.test(String(e.rueck || ''));
      if (r === null && !istSpitze) continue;
      sek = istSpitze ? 0 : r;
      roh = istSpitze ? '0' : String(e.rueck).trim();
    } else {
      const z = zuSekunden(e.zeit);
      if (z === null) continue;
      sek = z; roh = String(e.zeit).trim();
    }
    mitZeit.push({ nr: e.nr, sek, roh });
  }
  if (mitZeit.length === 0) return { modus: null, gruppen: [] };
  mitZeit.sort((a, b) => a.sek - b.sek || a.nr - b.nr);

  // Taugt die Rohschreibweise als Gruppenschluessel? Ein einzelner
  // Doppeltreffer reicht nicht: bei einem Einzelzeitfahren teilen sich
  // zufaellig zwei Fahrer eine Hundertstelzeit, und die Regel meldete
  // dann "gleiche Zeit" fuer 123 Gruppen zu je einem Fahrer. Verlangt
  // wird, dass die Zeiten sich wirklich buendeln.
  const zaehler = new Map();
  for (const e of mitZeit) zaehler.set(e.roh, (zaehler.get(e.roh) || 0) + 1);
  const groesste = Math.max(...zaehler.values());
  const nachGleich = !erzwinge
    && zaehler.size <= mitZeit.length * 0.6
    && groesste >= 2;

  const roh = [];
  let akt = null;
  for (const e of mitZeit) {
    const neu = !akt || (nachGleich
      ? e.roh !== akt.roh
      : (e.sek - akt.letzte) > schwelle);
    if (neu) { akt = { roh: e.roh, sek: e.sek, letzte: e.sek, nrs: [e.nr] }; roh.push(akt); }
    else     { akt.nrs.push(e.nr); akt.letzte = e.sek; }
  }

  const spitze = roh[0].sek;
  return {
    modus: nachGleich ? 'gleich' : 'schwelle',
    gruppen: roh.map((g, i) => ({
      riders: g.nrs,
      gap:    i === 0 ? null : ausSekunden(g.sek - spitze),
      gapSek: i === 0 ? 0    : Math.round(g.sek - spitze)
    }))
  };
}

// ---------------------------------------------------------------------
// Kategorie <-> Rennen
// ---------------------------------------------------------------------
// Der Zeitnehmer schreibt "U17 Maennlich", im Livetracking heisst das
// Rennen "U17m". Beides auf eine gemeinsame Form bringen, dann
// vergleichen. Das Ergebnis ist ein Vorschlag zur Vorbelegung - eine
// Zuordnung entsteht erst durch Bestaetigen.
function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .replace(/mannlich|manner|herren|male|boys/g, 'm')
    .replace(/weiblich|frauen|damen|female|girls/g, 'w')
    .replace(/juniorinnen/g, 'w').replace(/junioren/g, 'm')
    .replace(/schuler|jugend|klasse/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// 0 = kein Bezug, 1 = sicher. Ab 0.5 wird vorbelegt.
function guete(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.8;
  const ak = /u\d{2}/;
  const ax = (x.match(ak) || [])[0], ay = (y.match(ak) || [])[0];
  if (ax && ax === ay) {
    const gx = /m$|w$/.exec(x), gy = /m$|w$/.exec(y);
    if (gx && gy) return gx[0] === gy[0] ? 0.75 : 0;
    return 0.5;
  }
  return 0;
}

// Bestes Rennen zu einer Kategorie. rennen: [{id, name, category}]
function passtZu(katName, rennen) {
  let best = null, bg = 0;
  for (const r of (rennen || [])) {
    const g = Math.max(guete(katName, r.name), guete(katName, r.category || ''));
    if (g > bg) { bg = g; best = r; }
  }
  return bg >= 0.5 ? { id: best.id, guete: Number(bg.toFixed(2)) } : null;
}

// ---------------------------------------------------------------------
// Listenwahl
// ---------------------------------------------------------------------
// Bewusst bei jedem Durchlauf neu statt einmal festgeschrieben: die
// Namen aendern sich waehrend der Vorbereitung, und die Liste, die im
// Rennen gilt, legt der Zeitnehmer teils erst am Morgen an. Gesucht
// wird unter den Listen des Contests die mit Zeitspalte und den
// meisten Zeilen; als "Live" gekennzeichnete haben Vorrang.
// Eine leere Liste gewinnt nie, auch nicht als "Live" gekennzeichnet.
// Am 01.09.2026 im Integrationstest aufgefallen: der Zeitnehmer haelt
// "03-Online LIVE|LIVE Time Trial" bereit, solange das Zeitfahren noch
// nicht laeuft, hat sie null Zeilen - und verdraengte damit die
// Ergebnisliste mit 124 Fahrern. Der Livevorzug greift erst, wenn
// wirklich Daten drinstehen.
function bewerteListe(l) {
  if (!l.abrufbar || l.art !== 'ergebnis') return -1;
  if (!l.zeilen) return -1;
  return (l.live ? 1000000 : 0) + l.zeilen;
}

function waehleListe(reiter, contest) {
  let best = null, bw = 0;
  for (const r of (reiter || [])) {
    for (const l of r.listen) {
      if (String(l.contest) !== String(contest)) continue;
      const w = bewerteListe(l);
      if (w > bw) { bw = w; best = { tab: r.tab, name: l.name, live: l.live, zeilen: l.zeilen }; }
    }
  }
  return best;
}

// Dasselbe fuer Startlisten - dort zaehlt nur, dass Namen drinstehen.
function waehleStartliste(reiter, contest) {
  let best = null, bz = -1;
  for (const r of (reiter || [])) {
    for (const l of r.listen) {
      if (String(l.contest) !== String(contest)) continue;
      if (!l.abrufbar || !l.zeilen) continue;
      // Ergebnislisten taugen zur Not auch, Startlisten sind besser.
      const w = (l.art === 'startliste' ? 1000000 : 0) + l.zeilen;
      if (w > bz) { bz = w; best = { tab: r.tab, name: l.name, zeilen: l.zeilen }; }
    }
  }
  return best;
}

module.exports = {
  eventIdAus, erkunde, holeConfig, holeListe,
  alsFahrer, alsErgebnis, zuGruppen, zuSekunden, ausSekunden,
  zuordnung, sauber, artDerListe,
  normName, guete, passtZu, waehleListe, waehleStartliste,
  BASIS_HOST
};
