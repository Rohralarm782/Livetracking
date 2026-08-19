// LT Background Test v1.0.0
// Stufe 1: Isolierter Test des Foreground Service + Location Task.
// Kein Server, keine Integration. Ziel: lueckenlose Punkte bei Display aus.

import { useEffect, useState, useCallback } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, StatusBar, Platform,
} from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';

const TASK_NAME = 'LT_BG_LOCATION';
const LOG_KEY = 'lt_bg_log_v1';
const MAX_ENTRIES = 3000;
const INTERVAL_MS = 5000;

// ---------------------------------------------------------------------------
// Log-Schreiber. Laeuft sowohl im UI-Kontext als auch im Task-Kontext.
// Der Task hat einen EIGENEN JS-Kontext ohne Zugriff auf React-State,
// deshalb geht die Uebergabe ausschliesslich ueber AsyncStorage.
// ---------------------------------------------------------------------------
async function appendLog(entries) {
  try {
    const raw = await AsyncStorage.getItem(LOG_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    for (const e of entries) arr.push(e);
    if (arr.length > MAX_ENTRIES) arr.splice(0, arr.length - MAX_ENTRIES);
    await AsyncStorage.setItem(LOG_KEY, JSON.stringify(arr));
  } catch (err) {
    // Bewusst still: ein fehlgeschlagener Log-Schreibvorgang darf den
    // Location-Task nicht abbrechen.
  }
}

async function readLog() {
  try {
    const raw = await AsyncStorage.getItem(LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Der Task MUSS auf Modulebene definiert werden, ausserhalb der Komponente.
// Android startet den Prozess nach einem Kill neu und erwartet die
// Registrierung, bevor irgendein Render passiert.
// ---------------------------------------------------------------------------
TaskManager.defineTask(TASK_NAME, async ({ data, error }) => {
  const now = Date.now();
  if (error) {
    await appendLog([{ r: now, ev: 'task_error', msg: String(error.message || error) }]);
    return;
  }
  const locs = (data && data.locations) || [];
  if (!locs.length) {
    await appendLog([{ r: now, ev: 'task_empty' }]);
    return;
  }
  await appendLog(locs.map((l) => ({
    r: now,
    t: l.timestamp,
    lat: Number(l.coords.latitude.toFixed(6)),
    lon: Number(l.coords.longitude.toFixed(6)),
    acc: l.coords.accuracy == null ? null : Math.round(l.coords.accuracy),
    spd: l.coords.speed == null ? null : Number(l.coords.speed.toFixed(1)),
  })));
});

// ---------------------------------------------------------------------------
// Auswertung: was uns wirklich interessiert sind die Luecken.
// ---------------------------------------------------------------------------
function analyse(log) {
  const fixes = log.filter((e) => e.t != null).sort((a, b) => a.t - b.t);
  if (fixes.length < 2) {
    return { count: fixes.length, events: log.filter((e) => e.ev), gaps: [], maxGap: 0, duration: 0, first: null, last: null };
  }
  const gaps = [];
  for (let i = 1; i < fixes.length; i++) {
    const d = fixes[i].t - fixes[i - 1].t;
    if (d > INTERVAL_MS * 3) gaps.push({ at: fixes[i - 1].t, sec: Math.round(d / 1000) });
  }
  const first = fixes[0].t;
  const last = fixes[fixes.length - 1].t;
  const maxGap = gaps.reduce((m, g) => Math.max(m, g.sec), 0);
  return {
    count: fixes.length,
    events: log.filter((e) => e.ev),
    gaps,
    maxGap,
    duration: Math.round((last - first) / 1000),
    first,
    last,
  };
}

const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString('de-DE') : '–');

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

  const refresh = useCallback(async () => {
    const isOn = await Location.hasStartedLocationUpdatesAsync(TASK_NAME).catch(() => false);
    setRunning(isOn);
    const log = await readLog();
    setStats(analyse(log));
    setTail(log.slice(-25).reverse());
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);

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
      setStatus('Frage Berechtigung an …');
      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.status !== 'granted') {
        setStatus('Standort-Berechtigung abgelehnt. Test nicht moeglich.');
        return;
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

      await appendLog([{ r: Date.now(), ev: 'started' }]);
      setStatus('Laeuft. Display ausschalten und losfahren.');
      refresh();
    } catch (err) {
      setStatus('Fehler beim Start: ' + String(err.message || err));
    }
  }

  async function stop() {
    try {
      await Location.stopLocationUpdatesAsync(TASK_NAME);
      await appendLog([{ r: Date.now(), ev: 'stopped' }]);
      setStatus('Gestoppt. Auswertung unten.');
      refresh();
    } catch (err) {
      setStatus('Fehler beim Stoppen: ' + String(err.message || err));
    }
  }

  async function clear() {
    await AsyncStorage.removeItem(LOG_KEY);
    setStatus('Log geloescht.');
    refresh();
  }

  const ok = stats && stats.count > 1 && stats.gaps.length === 0;

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#101317" />
      <ScrollView contentContainerStyle={s.pad}>
        <Text style={s.h1}>Hintergrund-Test</Text>

        <View style={[s.badge, running ? s.badgeOn : s.badgeOff]}>
          <Text style={s.badgeText}>{running ? 'AUFZEICHNUNG LÄUFT' : 'GESTOPPT'}</Text>
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
            <Text style={[s.verdict, ok ? s.verdictOk : s.verdictBad]}>
              {stats.count < 2
                ? 'Noch zu wenig Daten'
                : ok
                ? 'Lückenlos — Stufe 1 bestanden'
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
            <Text key={i} style={s.mono}>
              {e.t
                ? `${clock(e.t)}  ${e.lat}, ${e.lon}  ±${e.acc}m  ${e.spd ?? '–'}m/s`
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
  foot: { color: '#5a6675', fontSize: 12, textAlign: 'center', marginTop: 12, fontFamily: MONO },
});
