// LT Tracker v1.2.0
// Stufe 3: Die App zeigt die Website und sendet nebenher die Position.
// Zwei unabhaengige Wege zum Server - der native Sender mit Tracker-Key,
// das WebView mit normaler Anmeldung. Faellt einer aus, laeuft der andere.

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, StatusBar, Platform,
  TextInput, PermissionsAndroid, BackHandler, ActivityIndicator,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Wird nach dem Laden der Seite ausgefuehrt. Blendet das Teamauto-
// Haekchen aus: es startet im Browser watchPosition und schreibt ueber
// /team-position auf denselben Marker wie der native Sender. Zwei
// Quellen auf einem Marker waeren nur verwirrend.
// Bewusst per CSS statt durch Aendern des Webcodes - im Browser am
// Rechner bleibt damit alles, wie es ist.
const INJECT = `
(function () {
  try {
    var st = document.createElement('style');
    st.textContent = '#teamCarToggle{display:none !important;}';
    (document.head || document.documentElement).appendChild(st);
    var cb = document.getElementById('teamCarCheckbox');
    if (cb && cb.checked) {
      cb.checked = false;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch (e) {}
})();
true;
`;

const TASK_NAME = 'LT_BG_LOCATION';
const STAT_KEY = 'lt_stat_v2';
const TAIL_KEY = 'lt_tail_v2';
const CFG_KEY = 'lt_cfg_v1';
const TAIL_MAX = 40;
const GAPS_MAX = 50;
const EVENTS_MAX = 30;
const INTERVAL_MS = 5000;

// Android liefert beim Abonnieren sofort die letzte bekannte Position
// aus - im Stufe-1-Test war die 2:18 alt. Bei 80 km/h waeren das fast
// drei Kilometer daneben. Solche Fixes werden protokolliert, aber nicht
// gesendet.
const MAX_FIX_AGE_MS = 30 * 1000;

// fetch kennt keinen eigenen Timeout. Ohne AbortController haengt eine
// Anfrage im Funkloch, bis das System sie irgendwann aufgibt - und der
// naechste Fix laeuft derweil auf.
const SEND_TIMEOUT_MS = 8000;

const DEFAULT_CFG = {
  serverUrl: 'https://livetracking-fq4l.onrender.com',
  trackerKey: '',
  trackerId: 'TEAMAUTO',
};

async function readCfg() {
  try {
    const raw = await AsyncStorage.getItem(CFG_KEY);
    return raw ? { ...DEFAULT_CFG, ...JSON.parse(raw) } : { ...DEFAULT_CFG };
  } catch (err) {
    return { ...DEFAULT_CFG };
  }
}

async function writeCfg(cfg) {
  await AsyncStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

// ---------------------------------------------------------------------------
// Versand eines einzelnen Punktes. Wirft nie - der Aufrufer im Task darf
// unter keinen Umstaenden abbrechen. Rueckgabe beschreibt das Ergebnis,
// damit die Auswertung Netz- von GPS-Problemen unterscheiden kann.
// ---------------------------------------------------------------------------
async function sendPoint(cfg, point) {
  if (!cfg.serverUrl) return { sent: 'cfg', msg: 'keine Server-URL' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(cfg.serverUrl.replace(/\/+$/, '') + '/positions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tracker-key': cfg.trackerKey || '',
      },
      body: JSON.stringify({
        id: cfg.trackerId || 'TEAMAUTO',
        lat: point.lat,
        lon: point.lon,
        acc: point.acc == null ? undefined : point.acc,
        spd: point.spd == null ? undefined : point.spd,
        ts: point.t,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { sent: 'err', code: res.status };
    const body = await res.json().catch(() => ({}));
    if (body && body.skipped) return { sent: 'skip', msg: body.skipped };
    return { sent: 'ok' };
  } catch (err) {
    // Die Meldung eines abgebrochenen fetch lautet je nach Version
    // "Aborted", "AbortError" oder "The user aborted a request" -
    // deshalb kein exakter Vergleich.
    const m = String(err && err.message ? err.message : err);
    const aborted = /abort/i.test(m) || (err && err.name === 'AbortError');
    return { sent: 'err', msg: aborted ? 'Timeout' : m.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Protokoll. Laeuft sowohl im UI- als auch im Task-Kontext. Der Task hat
// einen EIGENEN JS-Kontext ohne Zugriff auf React-State, deshalb geht die
// Uebergabe ausschliesslich ueber AsyncStorage.
//
// Bewusst NICHT als wachsende Liste aller Punkte: bei 5 s Intervall und
// einer Stunde Fahrt waeren das rund 700 Eintraege, also gut 300 KB, die
// alle 5 Sekunden komplett gelesen, geparst und zurueckgeschrieben
// wuerden - hochgerechnet ueber 200 MB Schreiblast pro Stunde, nur fuer
// ein Protokoll. Stattdessen zwei kleine Schluessel:
//   STAT_KEY  laufend fortgeschriebene Kennzahlen, wenige KB
//   TAIL_KEY  die letzten TAIL_MAX Punkte fuer die Anzeige
// ---------------------------------------------------------------------------
const EMPTY_STAT = {
  count: 0, first: null, last: null, lastFixTs: null,
  gaps: [], dropped: 0,
  tally: { ok: 0, err: 0, alt: 0, skip: 0, cfg: 0 },
  lastErr: null, events: [],
};

async function readJson(key, fallback) {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

async function readStat() {
  const s = await readJson(STAT_KEY, null);
  return s ? { ...EMPTY_STAT, ...s, tally: { ...EMPTY_STAT.tally, ...(s.tally || {}) } }
           : { ...EMPTY_STAT };
}

// Punkte einarbeiten. Luecken werden im Vorbeigehen erkannt, statt am
// Ende ueber die gesamte Liste gerechnet.
async function recordPoints(points) {
  try {
    const stat = await readStat();
    for (const p of points) {
      if (p.sent && stat.tally[p.sent] !== undefined) stat.tally[p.sent]++;
      if (p.sent === 'err') stat.lastErr = { at: p.r, code: p.code, msg: p.msg };
      if (p.sent === 'alt') { stat.dropped++; continue; }

      if (stat.lastFixTs != null) {
        const d = p.t - stat.lastFixTs;
        if (d > INTERVAL_MS * 3) {
          stat.gaps.push({ at: stat.lastFixTs, sec: Math.round(d / 1000) });
          if (stat.gaps.length > GAPS_MAX) stat.gaps.shift();
        }
      }
      if (stat.first == null) stat.first = p.t;
      stat.last = p.t;
      stat.lastFixTs = p.t;
      stat.count++;
    }
    const tail = await readJson(TAIL_KEY, []);
    for (const p of points) tail.push(p);
    if (tail.length > TAIL_MAX) tail.splice(0, tail.length - TAIL_MAX);
    await AsyncStorage.multiSet([
      [STAT_KEY, JSON.stringify(stat)],
      [TAIL_KEY, JSON.stringify(tail)],
    ]);
  } catch (err) {
    // Bewusst still: ein fehlgeschlagener Schreibvorgang darf den
    // Location-Task nicht abbrechen.
  }
}

async function recordEvent(ev, msg) {
  try {
    const stat = await readStat();
    const entry = { r: Date.now(), ev };
    if (msg) entry.msg = String(msg).slice(0, 200);
    stat.events.push(entry);
    if (stat.events.length > EVENTS_MAX) stat.events.shift();
    // Nach einem Neustart nicht faelschlich eine Riesenluecke melden.
    if (ev === 'started') stat.lastFixTs = null;
    const tail = await readJson(TAIL_KEY, []);
    tail.push(entry);
    if (tail.length > TAIL_MAX) tail.splice(0, tail.length - TAIL_MAX);
    await AsyncStorage.multiSet([
      [STAT_KEY, JSON.stringify(stat)],
      [TAIL_KEY, JSON.stringify(tail)],
    ]);
  } catch (err) {
    // siehe oben
  }
}

async function clearLog() {
  try { await AsyncStorage.multiRemove([STAT_KEY, TAIL_KEY]); } catch (err) {}
}

// ---------------------------------------------------------------------------
// Der Task MUSS auf Modulebene definiert werden, ausserhalb der Komponente.
// Android startet den Prozess nach einem Kill neu und erwartet die
// Registrierung, bevor irgendein Render passiert.
// ---------------------------------------------------------------------------
TaskManager.defineTask(TASK_NAME, async ({ data, error }) => {
  const now = Date.now();
  if (error) {
    await recordEvent('task_error', String(error.message || error));
    return;
  }
  const locs = (data && data.locations) || [];
  if (!locs.length) {
    await recordEvent('task_empty');
    return;
  }

  const cfg = await readCfg();
  const points = locs.map((l) => ({
    r: now,
    t: l.timestamp,
    age: Math.max(0, now - l.timestamp),
    lat: Number(l.coords.latitude.toFixed(6)),
    lon: Number(l.coords.longitude.toFixed(6)),
    acc: l.coords.accuracy == null ? null : Math.round(l.coords.accuracy),
    spd: l.coords.speed == null ? null : Number(l.coords.speed.toFixed(1)),
  }));

  // Kommen mehrere Fixes im selben Zyklus, ist nur der juengste
  // interessant - die aelteren wuerden am Server ohnehin als
  // out-of-order abgewiesen.
  const newest = points.reduce((a, b) => (b.t > a.t ? b : a), points[0]);

  for (const p of points) {
    if (p !== newest)                { p.sent = 'skip'; p.msg = 'nicht juengster'; continue; }
    if (p.age > MAX_FIX_AGE_MS)      { p.sent = 'alt';  continue; }
    const r = await sendPoint(cfg, p);
    p.sent = r.sent;
    if (r.code) p.code = r.code;
    if (r.msg)  p.msg  = r.msg;
  }

  await recordPoints(points);
});

// ---------------------------------------------------------------------------
// Ableitungen aus den laufend gefuehrten Kennzahlen. Die Luecken selbst
// werden bereits beim Eintragen erkannt, hier bleibt nur die Verdichtung.
// ---------------------------------------------------------------------------
function derive(stat) {
  const maxGap = stat.gaps.reduce((m, g) => Math.max(m, g.sec), 0);
  const duration = (stat.first != null && stat.last != null)
    ? Math.round((stat.last - stat.first) / 1000)
    : 0;
  return { ...stat, maxGap, duration };
}

const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString('de-DE') : '–');

// Kurzzeichen fuer den Versandstatus in der Punkteliste.
function sentMark(e) {
  switch (e.sent) {
    case 'ok':   return '\u2713';
    case 'err':  return '\u2717 ' + (e.code ? 'HTTP ' + e.code : e.msg || 'Fehler');
    case 'alt':  return 'alt';
    case 'skip': return '\u2013';
    case 'cfg':  return 'keine Konfig';
    default:     return '';
  }
}

const hms = (sec) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
};

export default function App() {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('Bereit');
  const [stats, setStats] = useState(null);
  const [tail, setTail] = useState([]);
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const [showCfg, setShowCfg] = useState(false);
  const [cfgSaved, setCfgSaved] = useState(true);
  const [webReady, setWebReady] = useState(false);
  const [webError, setWebError] = useState(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const webRef = useRef(null);

  // Zurueck-Taste blaettert in der Website statt die App zu schliessen.
  useEffect(() => {
    const onBack = () => {
      if (showCfg) { setShowCfg(false); return true; }
      if (canGoBack && webRef.current) { webRef.current.goBack(); return true; }
      return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [canGoBack, showCfg]);

  const refresh = useCallback(async () => {
    const isOn = await Location.hasStartedLocationUpdatesAsync(TASK_NAME).catch(() => false);
    setRunning(isOn);
    const stat = await readStat();
    setStats(derive(stat));
    const t = await readJson(TAIL_KEY, []);
    setTail(t.slice().reverse());
  }, []);

  useEffect(() => {
    readCfg().then((c) => {
      setCfg(c);
      // Ohne Schluessel kommt der Server nicht in Frage - Einstellungen
      // gleich aufklappen statt den Nutzer suchen zu lassen.
      if (!c.trackerKey) setShowCfg(true);
    });
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);

  function editCfg(field, value) {
    setCfg((c) => ({ ...c, [field]: value }));
    setCfgSaved(false);
  }

  async function saveCfg() {
    await writeCfg(cfg);
    setCfgSaved(true);
    setStatus('Einstellungen gespeichert.');
  }

  // Einzelner Probeversand, damit die Konfiguration ohne Testfahrt
  // pruefbar ist. Nutzt bewusst denselben Weg wie der Task.
  async function testSend() {
    setStatus('Sende Testpunkt …');
    await writeCfg(cfg);
    setCfgSaved(true);
    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const r = await sendPoint(cfg, {
        t: pos.timestamp,
        lat: Number(pos.coords.latitude.toFixed(6)),
        lon: Number(pos.coords.longitude.toFixed(6)),
        acc: pos.coords.accuracy == null ? null : Math.round(pos.coords.accuracy),
        spd: pos.coords.speed == null ? null : Number(pos.coords.speed.toFixed(1)),
      });
      if (r.sent === 'ok')        setStatus('Testpunkt angekommen. Server erreichbar.');
      else if (r.sent === 'skip') setStatus('Server hat verworfen: ' + r.msg);
      else if (r.code === 401)    setStatus('401 – Tracker-Key stimmt nicht.');
      else if (r.code)            setStatus('HTTP ' + r.code + ' vom Server.');
      else                        setStatus('Kein Kontakt: ' + (r.msg || 'unbekannt'));
    } catch (err) {
      setStatus('Testpunkt fehlgeschlagen: ' + String(err.message || err));
    }
  }

  async function beginUpdates() {
    await Location.startLocationUpdatesAsync(TASK_NAME, {
      accuracy: Location.Accuracy.High,
      timeInterval: INTERVAL_MS,
      distanceInterval: 0,
      // Ohne dieses Flag pausiert das System die Updates nach eigenem Ermessen.
      pausesUpdatesAutomatically: false,
      activityType: Location.ActivityType.AutomotiveNavigation,
      showsBackgroundLocationIndicator: true,
      // Keine Sammel-Zustellung — wir wollen jeden Punkt sofort sehen.
      deferredUpdatesInterval: 0,
      deferredUpdatesDistance: 0,
      foregroundService: {
        notificationTitle: 'Livetracking Test',
        notificationBody: 'Position wird aufgezeichnet',
        notificationColor: '#4aa3ff',
        // Service ueberlebt das Wegwischen der App aus dem Task-Switcher.
        killServiceOnDestroy: false,
      },
    });
  }

  async function start() {
    try {
      // Konfiguration festschreiben, bevor der Task laeuft: er liest sie
      // aus AsyncStorage, nicht aus dem React-State.
      await writeCfg(cfg);
      setCfgSaved(true);

      setStatus('Frage Berechtigung an …');
      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.status !== 'granted') {
        setStatus('Standort-Berechtigung abgelehnt. Test nicht moeglich.');
        return;
      }

      // Ab Android 13 ist die Benachrichtigung eigens zu erlauben. Ohne
      // sie laeuft der Service zwar, ist aber unsichtbar - im Rennen
      // faellt ein Ausfall dann erst auf, wenn jemand anruft.
      if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
        try {
          await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
          );
        } catch (err) {
          // Nicht kritisch - Tracking laeuft auch ohne sichtbare Meldung.
        }
      }

      setStatus('Starte Service …');
      try {
        await beginUpdates();
      } catch (err) {
        // Manche expo-location-Versionen verlangen zusaetzlich die
        // Hintergrund-Berechtigung, obwohl der Foreground Service sie
        // auf Android-Ebene ueberfluessig macht. Zweiter Versuch.
        setStatus('Brauche "Immer zulassen" – bitte in den Einstellungen setzen');
        const bg = await Location.requestBackgroundPermissionsAsync();
        if (bg.status !== 'granted') {
          setStatus('Hintergrund-Berechtigung abgelehnt: ' + String(err.message || err));
          return;
        }
        await beginUpdates();
      }

      await recordEvent('started');
      setStatus('Laeuft. Display ausschalten und losfahren.');
      refresh();
    } catch (err) {
      setStatus('Fehler beim Start: ' + String(err.message || err));
    }
  }

  async function stop() {
    try {
      await Location.stopLocationUpdatesAsync(TASK_NAME);
      await recordEvent('stopped');
      setStatus('Gestoppt. Auswertung unten.');
      refresh();
    } catch (err) {
      setStatus('Fehler beim Stoppen: ' + String(err.message || err));
    }
  }

  async function clear() {
    await clearLog();
    setStatus('Log geloescht.');
    refresh();
  }

  const ok = stats && stats.count > 1 && stats.gaps.length === 0;

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#101317" />

      {/* Schmale Leiste: Zustand des Senders, immer sichtbar. */}
      <View style={s.bar}>
        <View style={[s.dot, running ? s.dotOn : s.dotOff]} />
        <View style={s.barTextWrap}>
          <Text style={s.barTitle} numberOfLines={1}>
            {running ? (cfg.trackerId || 'TEAMAUTO') : 'Sender aus'}
          </Text>
          {running && stats && (
            <Text style={s.barSub} numberOfLines={1}>
              {stats.tally.ok} gesendet
              {stats.tally.err > 0 ? ` · ${stats.tally.err} Fehler` : ''}
            </Text>
          )}
        </View>
        <Pressable
          style={[s.barBtn, running ? s.barBtnStop : s.barBtnGo]}
          onPress={running ? stop : start}
        >
          <Text style={s.barBtnText}>{running ? 'Stopp' : 'Start'}</Text>
        </Pressable>
        <Pressable style={s.barIcon} onPress={() => setShowCfg((v) => !v)}>
          <Text style={s.barIconText}>{showCfg ? '\u2715' : '\u2699'}</Text>
        </Pressable>
      </View>

      {/* Die Website. Bleibt dauerhaft geladen, damit die Anmeldung und
          die Kartenposition beim Wechsel in die Einstellungen erhalten
          bleiben. */}
      <View style={s.webWrap}>
        <WebView
          key={reloadKey}
          ref={webRef}
          source={{ uri: (cfg.serverUrl || '').replace(/\/+$/, '') || DEFAULT_CFG.serverUrl }}
          style={s.web}
          javaScriptEnabled
          domStorageEnabled
          // Der native Sender macht die Ortung. Der Website den Zugriff
          // zu verweigern verhindert, dass zwei Quellen gleichzeitig
          // senden.
          geolocationEnabled={false}
          allowFileAccess
          originWhitelist={['*']}
          pullToRefreshEnabled
          injectedJavaScript={INJECT}
          applicationNameForUserAgent="LivetrackingApp/1.2"
          onLoadEnd={() => setWebReady(true)}
          onNavigationStateChange={(n) => setCanGoBack(n.canGoBack)}
          onError={(e) => setWebError(e.nativeEvent.description || 'Ladefehler')}
          onHttpError={(e) => {
            const c = e.nativeEvent.statusCode;
            if (c >= 500) setWebError('Server antwortet mit ' + c);
          }}
        />

        {!webReady && !webError && (
          <View style={s.webOverlay}>
            <ActivityIndicator size="large" color="#4aa3ff" />
            <Text style={s.webNote}>Lade Livetracking …</Text>
            <Text style={s.webHint}>
              Nach laengerer Pause faehrt der Server erst hoch. Das kann
              bis zu einer Minute dauern.
            </Text>
          </View>
        )}

        {webError && (
          <View style={s.webOverlay}>
            <Text style={s.webErr}>Website nicht erreichbar</Text>
            <Text style={s.webHint}>{webError}</Text>
            <Text style={s.webHint}>
              Die Positionsuebertragung laeuft davon unabhaengig weiter.
            </Text>
            <Pressable
              style={[s.btn, s.btnAlt, s.webRetry]}
              onPress={() => { setWebError(null); setWebReady(false); setReloadKey((k) => k + 1); }}
            >
              <Text style={s.btnText}>Erneut versuchen</Text>
            </Pressable>
          </View>
        )}
      </View>

      {showCfg && (
      <ScrollView style={s.panel} contentContainerStyle={s.pad}>
        <Text style={s.h1}>Sender</Text>

        <View style={[s.badge, running ? s.badgeOn : s.badgeOff]}>
          <Text style={s.badgeText}>
            {running ? `SENDET ALS ${cfg.trackerId || 'TEAMAUTO'}` : 'GESTOPPT'}
          </Text>
        </View>

        <Text style={s.status}>{status}</Text>

        <View style={s.row}>
          <Pressable
            style={[s.btn, running && s.btnDim]}
            onPress={start}
            disabled={running}
          >
            <Text style={s.btnText}>Start</Text>
          </Pressable>
          <Pressable
            style={[s.btn, !running && s.btnDim]}
            onPress={stop}
            disabled={!running}
          >
            <Text style={s.btnText}>Stopp</Text>
          </Pressable>
        </View>

        <Pressable style={[s.btn, s.btnGhost]} onPress={() => setShowCfg(false)}>
          <Text style={s.btnText}>
            Zurueck zur Karte{cfgSaved ? '' : '  •'}
          </Text>
        </Pressable>

        {true && (
          <View style={s.card}>
            <Text style={s.h2}>Verbindung</Text>

            <Text style={s.label}>Server-URL</Text>
            <TextInput
              style={s.input}
              value={cfg.serverUrl}
              onChangeText={(v) => editCfg('serverUrl', v)}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://…"
              placeholderTextColor="#5a6675"
            />

            <Text style={s.label}>Tracker-Key</Text>
            <TextInput
              style={s.input}
              value={cfg.trackerKey}
              onChangeText={(v) => editCfg('trackerKey', v)}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="muss zu TRACKER_KEY auf Render passen"
              placeholderTextColor="#5a6675"
            />

            <Text style={s.label}>Tracker-ID</Text>
            <TextInput
              style={s.input}
              value={cfg.trackerId}
              onChangeText={(v) => editCfg('trackerId', v)}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="TEAMAUTO"
              placeholderTextColor="#5a6675"
            />
            <Text style={s.hint}>
              TEAMAUTO ergibt den roten Marker. Ein anderer Name erscheint als
              normaler Tracker auf der Karte.
            </Text>

            <View style={s.row}>
              <Pressable style={[s.btn, cfgSaved && s.btnDim]} onPress={saveCfg}>
                <Text style={s.btnText}>Speichern</Text>
              </Pressable>
              <Pressable style={[s.btn, s.btnAlt]} onPress={testSend}>
                <Text style={s.btnText}>Testpunkt</Text>
              </Pressable>
            </View>
          </View>
        )}

        {stats && stats.tally && (
          <View style={s.card}>
            <Text style={s.h2}>Versand</Text>
            <Row k="Angekommen" v={String(stats.tally.ok)} />
            <Row
              k="Fehlgeschlagen"
              v={String(stats.tally.err)}
              bad={stats.tally.err > 0}
            />
            <Row k="Zu alt, nicht gesendet" v={String(stats.tally.alt)} />
            <Row k="Vom Server verworfen" v={String(stats.tally.skip)} />
            {stats.tally.cfg > 0 && (
              <Row k="Ohne Konfiguration" v={String(stats.tally.cfg)} bad />
            )}
            {stats.lastErr && (
              <Text style={s.mono}>
                Letzter Fehler {clock(stats.lastErr.at)}:{' '}
                {stats.lastErr.code ? 'HTTP ' + stats.lastErr.code : stats.lastErr.msg}
              </Text>
            )}
          </View>
        )}

        {stats && (
          <View style={s.card}>
            <Text style={s.h2}>Auswertung</Text>
            <Row k="Punkte" v={String(stats.count)} />
            <Row k="Erster Fix" v={clock(stats.first)} />
            <Row k="Letzter Fix" v={clock(stats.last)} />
            <Row k="Zeitraum" v={hms(stats.duration)} />
            <Row
              k="Lücken > 15s"
              v={String(stats.gaps.length)}
              bad={stats.gaps.length > 0}
            />
            <Row
              k="Größte Lücke"
              v={stats.maxGap ? hms(stats.maxGap) : 'keine'}
              bad={stats.maxGap > 0}
            />
            {stats.dropped > 0 && (
              <Row k="Verworfene Alt-Fixes" v={String(stats.dropped)} />
            )}
            <Text style={[s.verdict, ok ? s.verdictOk : s.verdictBad]}>
              {stats.count < 2
                ? 'Noch zu wenig Daten'
                : ok
                ? 'Lückenlos'
                : 'Lücken vorhanden — siehe Liste'}
            </Text>
          </View>
        )}

        {stats && stats.gaps.length > 0 && (
          <View style={s.card}>
            <Text style={s.h2}>Lücken</Text>
            {stats.gaps.slice(-15).map((g, i) => (
              <Text key={i} style={s.mono}>
                {clock(g.at)}  →  {hms(g.sec)} ohne Fix
              </Text>
            ))}
          </View>
        )}

        {stats && stats.events.length > 0 && (
          <View style={s.card}>
            <Text style={s.h2}>Ereignisse</Text>
            {stats.events.slice(-15).map((e, i) => (
              <Text key={i} style={s.mono}>
                {clock(e.r)}  {e.ev}{e.msg ? '  ' + e.msg : ''}
              </Text>
            ))}
          </View>
        )}

        <View style={s.card}>
          <Text style={s.h2}>Letzte Punkte</Text>
          {tail.length === 0 && <Text style={s.mono}>– noch nichts –</Text>}
          {tail.map((e, i) => (
            <Text key={i} style={[s.mono, e.sent === 'err' && s.monoBad]}>
              {e.t
                ? `${clock(e.t)}  ${e.lat}, ${e.lon}  ±${e.acc}m  ${sentMark(e)}`
                : `${clock(e.r)}  [${e.ev}]`}
            </Text>
          ))}
        </View>

        <Pressable style={[s.btn, s.btnGhost]} onPress={clear}>
          <Text style={s.btnText}>Log löschen</Text>
        </Pressable>

        <Text style={s.foot}>
          Intervall {INTERVAL_MS / 1000}s · Task {TASK_NAME} · {Platform.OS}
        </Text>
      </ScrollView>
      )}
    </View>
  );
}

function Row({ k, v, bad }) {
  return (
    <View style={s.kv}>
      <Text style={s.k}>{k}</Text>
      <Text style={[s.v, bad && s.vBad]}>{v}</Text>
    </View>
  );
}

const MONO = Platform.select({ android: 'monospace', ios: 'Menlo', default: 'monospace' });

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#101317' },

  // Statusleiste
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingTop: 44, paddingBottom: 10, paddingHorizontal: 14,
    backgroundColor: '#101317',
    borderBottomWidth: 1, borderBottomColor: '#232a33',
  },
  dot: { width: 12, height: 12, borderRadius: 6 },
  dotOn: { backgroundColor: '#4ade80' },
  dotOff: { backgroundColor: '#6b7280' },
  barTextWrap: { flex: 1 },
  barTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  barSub: { color: '#8fa3b8', fontSize: 12, fontFamily: MONO, marginTop: 1 },
  barBtn: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: 6 },
  barBtnGo: { backgroundColor: '#1d5f9e' },
  barBtnStop: { backgroundColor: '#5a2020' },
  barBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  barIcon: { paddingHorizontal: 8, paddingVertical: 8 },
  barIconText: { color: '#8fa3b8', fontSize: 20 },

  // WebView
  webWrap: { flex: 1, backgroundColor: '#fff' },
  web: { flex: 1 },
  webOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#101317', alignItems: 'center', justifyContent: 'center',
    padding: 32,
  },
  webNote: { color: '#c8d4e0', fontSize: 17, marginTop: 18 },
  webErr: { color: '#ff8f6b', fontSize: 19, fontWeight: '700', marginBottom: 12 },
  webHint: { color: '#6d7d8d', fontSize: 14, textAlign: 'center', marginTop: 10, lineHeight: 20 },
  webRetry: { marginTop: 24, alignSelf: 'stretch' },

  // Einstellungen als Ueberlagerung ueber der Website
  panel: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#101317',
  },

  pad: { padding: 20, paddingTop: 56, paddingBottom: 60 },
  h1: { color: '#fff', fontSize: 30, fontWeight: '700', marginBottom: 16 },
  h2: { color: '#8fa3b8', fontSize: 13, fontWeight: '700', letterSpacing: 1, marginBottom: 10, textTransform: 'uppercase' },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6, marginBottom: 12 },
  badgeOn: { backgroundColor: '#0f7a3d' },
  badgeOff: { backgroundColor: '#5a2020' },
  badgeText: { color: '#fff', fontWeight: '700', fontSize: 15, letterSpacing: 0.5 },
  status: { color: '#c8d4e0', fontSize: 16, marginBottom: 18, lineHeight: 22 },
  row: { flexDirection: 'row', gap: 12, marginBottom: 20 },
  btn: { flex: 1, backgroundColor: '#1d5f9e', paddingVertical: 18, borderRadius: 8, alignItems: 'center' },
  btnGhost: { backgroundColor: '#2a3038', marginTop: 4 },
  btnDim: { opacity: 0.35 },
  btnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  card: { backgroundColor: '#181d24', borderRadius: 10, padding: 16, marginBottom: 16 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  k: { color: '#8fa3b8', fontSize: 16 },
  v: { color: '#fff', fontSize: 16, fontWeight: '600', fontFamily: MONO },
  vBad: { color: '#ff8f6b' },
  verdict: { marginTop: 14, fontSize: 17, fontWeight: '700' },
  verdictOk: { color: '#4ade80' },
  verdictBad: { color: '#ff8f6b' },
  mono: { color: '#b9c6d4', fontSize: 13, fontFamily: MONO, paddingVertical: 2 },
  monoBad: { color: '#ff8f6b' },
  label: { color: '#8fa3b8', fontSize: 14, marginTop: 10, marginBottom: 4 },
  input: {
    backgroundColor: '#101317', color: '#fff', fontSize: 15, fontFamily: MONO,
    borderRadius: 6, paddingHorizontal: 12, paddingVertical: 12,
    borderWidth: 1, borderColor: '#2a3038',
  },
  hint: { color: '#6d7d8d', fontSize: 12, marginTop: 8, marginBottom: 4, lineHeight: 17 },
  btnAlt: { backgroundColor: '#2f6d46' },
  foot: { color: '#5a6675', fontSize: 12, textAlign: 'center', marginTop: 12, fontFamily: MONO },
});
