/*
 * ============================================================
 *  LivetrackingCIQBleDelegate.mc                        (v8)
 * ------------------------------------------------------------
 *  v2: Mehrzeilige Anzeige. Der empfangene Text wird am
 *      Trennzeichen ';' in Zeilen zerlegt - direkt beim
 *      Byte-Dekodieren, ohne String-Funktionen.
 *      Beispiel: "P3;0:15;0:20" -> drei Zeilen.
 *  v3: Zusaetzlich wird pro Zeile vermerkt, ob sie NUR aus
 *      Ziffern und Doppelpunkt besteht. Die View kann solche
 *      Zeilen dann in der grossen Ziffernschrift setzen.
 *      Auch das faellt beim Byte-Dekodieren nebenbei ab.
 *  v4: Trackerbindung und getakteter Scan.
 *      - Die Tracker-ID steht nicht mehr fest im Code. Der erste
 *        erfolgreich verbundene Tracker wird in Application.Storage
 *        gespeichert; danach ignoriert der Edge alle anderen.
 *      - Die Einstellung "trackerId" aus Garmin Connect kann eine
 *        Bindung erzwingen (leer = Automatik).
 *      - Der Scan laeuft nicht mehr dauerhaft: 60 s durchgehend,
 *        danach 10 s an / 50 s aus. Ein spaeter eingeschalteter
 *        Tracker wird trotzdem innerhalb einer Minute gefunden.
 *      - Ein gebundener Tracker, der 5 min lang nicht auftaucht,
 *        wird freigegeben (Ersatzgeraet ohne Handy montierbar).
 *      Taktgeber ist tick(), aufgerufen aus View.compute().
 *  v5: Zusammenfuehrung mit dem Anzeige-Zweig. Zwei Trennzeichen
 *      statt einem:
 *        ';'  neue Zeile, Pflichtinhalt
 *        '~'  neue Zeile, OPTIONAL (z.B. Startnummern)
 *      Optionale Zeilen laesst die View weg, wenn der Platz
 *      sonst nur mit unlesbar kleiner Schrift reichen wuerde.
 *      Beispiel: "6x 0:15~12 17 23;2x 1:00~8 9;..."
 *      LT_MAX_LINES 4 -> 8, weil eine Gruppe jetzt zwei Zeilen
 *      belegen kann.
 *  v6: Testschalter LT_TEST_TEXT fuer den Simulator. Ist er
 *      gesetzt, wird der String beim Start durch den echten
 *      Parser geschickt, damit sich das Layout ohne BLE pruefen
 *      laesst. Im Auslieferungszustand leer - der Codepfad ist
 *      dann tot.
 *  v7: Nur Kommentare - die Beispiele zeigen das neue Format mit
 *      dem 'x' hinter der Gruppengroesse ("6x 0:15").
 *  v8: Nachrichten werden aus mehreren Notifies zusammengesetzt.
 *      Der Edge 540 handelt keine groessere MTU aus als die
 *      Standard-23, es bleiben also 20 Byte Nutzlast je Notify -
 *      laengere Texte kamen stumm abgeschnitten an. Die
 *      Gegenstelle rahmt jetzt mit 0x02 / 0x03 und sendet in
 *      Haeppchen; hier wird gesammelt und erst bei 0x03
 *      ausgewertet. Ein 0x02 verwirft angefangenes Halbzeug.
 *      Bleibt der Abschluss aus, greift nach LT_FRAME_MS ein
 *      Notausgang - so bleibt auch ein ungerahmter Sender
 *      (Firmware vor v48.2.0) lesbar.
 * ============================================================
 *  Zweck : BLE-Client (GATT Central) fuer das Livetracking-
 *          Datenfeld. Sucht den ESP32-Tracker, verbindet sich,
 *          abonniert Notifications und haelt den zuletzt
 *          empfangenen Text bereit.
 *
 *  Gegenstelle: ESP32 mit BLE_Test_v1.ino (bzw. spaeter der
 *          produktive Tracker) als BLE-Peripheral.
 *
 *  WICHTIG: UUIDs muessen IDENTISCH mit dem ESP32-Sketch sein.
 *
 *  Ablauf (jeder Schritt ist im Datenfeld sichtbar):
 *    INIT -> PROF ok -> SCAN -> FOUND -> CONN -> SUB ok -> Daten
 * ============================================================
 */

import Toybox.Lang;
import Toybox.System;
using Toybox.Application;
using Toybox.BluetoothLowEnergy as Ble;

// --- Projekt-Konstanten (identisch mit BLE_Test_v1.ino) -----
const LT_SERVICE_UUID = "43b5d113-a206-4011-8218-95705d3300cd";
const LT_CHAR_UUID    = "14515bd1-cc1d-4ff4-9580-246228a21c8a";
// Der Geraetename setzt sich aus Praefix und Tracker-ID zusammen,
// z.B. "LT-" + "t1". Die ID steht NICHT mehr fest im Code, sondern
// kommt aus der Bindung (siehe unten).
const LT_NAME_PREFIX  = "LT-";

// --- Suchverhalten ------------------------------------------
// Phase 1: direkt nach dem Start durchgehend suchen.
const LT_INITIAL_SCAN_MS = 60000;
// Phase 2: getaktet suchen. Schont den Akku deutlich, findet einen
// erst beim Warmfahren eingeschalteten Tracker aber trotzdem
// spaetestens nach einer Minute.
const LT_SCAN_ON_MS      = 10000;
const LT_SCAN_OFF_MS     = 50000;
// Wird ein gebundener Tracker so lange nicht gefunden, gibt die App
// die Bindung frei und lernt den naechsten an. Rettungsnetz fuer den
// Fall "Tracker defekt, Ersatzgeraet montiert" - ohne Handy.
// Gilt nur fuer automatisch gelernte Bindungen, nicht fuer erzwungene.
const LT_FORGET_MS       = 300000;

// --- Bindung ------------------------------------------------
// Schluessel der dauerhaft gespeicherten Bindung (Application.Storage)
const LT_STORAGE_KEY = "boundTracker";
// Schluessel der Einstellung aus Garmin Connect (Application.Properties)
const LT_SETTING_KEY = "trackerId";

// Nach so vielen ms ohne neues Notify gilt der Wert als veraltet.
const LT_STALE_MS = 10000;

// --- Zusammensetzen mehrteiliger Nachrichten -----------------
// Rahmenbytes der Gegenstelle. Liegen ausserhalb 32..126, wuerden
// also selbst dann nicht im Text landen, wenn eines durchrutscht.
const LT_STX = 2;
const LT_ETX = 3;
// Obergrenze des Sammelpuffers. Etwas ueber DISPLAY_MAX (60) der
// Gegenstelle - schuetzt vor einem Sender, der nie abschliesst.
const LT_RX_MAX = 80;
// Bleibt der Abschluss aus, wird nach dieser Zeit trotzdem
// ausgewertet. Rettet die Anzeige bei ungerahmten Sendern.
const LT_FRAME_MS = 1500;

// --- Testschalter (nur fuer den Simulator) -------------------
// Der Simulator hat keinen Bluetooth-Stack, die Suche laeuft dort
// ins Leere und das Feld bleibt bei "PROF.." stehen. Steht hier ein
// Text, wird er beim Start durch bytesToLines() geschickt - echter
// Parser, echte Trennzeichen, nur ohne Funkstrecke. So laesst sich
// das Layout in beiden Feldgroessen pruefen.
// VOR DEM SIDELOAD AUF DEN EDGE WIEDER LEEREN.
// Beispiele:
//   "6x 0:15"                          eine Gruppe, ohne Nummern
//   "6x 0:15~12 17 23"                 mit optionaler Nummernzeile
//   "6x 0:15~12 17 23;2x 1:00~8 9;..." der Vollfall
const LT_TEST_TEXT = "";

// Trennzeichen fuer Zeilenumbrueche im Nutztext (';' = ASCII 59)
const LT_SEPARATOR = 59;
// Dasselbe, aber die folgende Zeile ist verzichtbar ('~' = ASCII 126)
const LT_SEP_OPT = 126;
// Mehr Zeilen werden verworfen - darunter wird die Schrift unlesbar.
const LT_MAX_LINES = 8;

// Zeichenbereich, den die Garmin-Ziffernschriften sicher enthalten:
// '0'-'9' (48-57) und ':' (58). Bewusst konservativ - ein fehlendes
// Zeichen erscheint als leeres Kaestchen und waere schlimmer als
// eine Schriftstufe weniger.
const LT_DIGIT_MIN = 48;
const LT_DIGIT_MAX = 58;

class LivetrackingCIQBleDelegate extends Ble.BleDelegate {

    // Klartext-Status fuer die Anzeige, solange keine Daten da sind
    hidden var mStatus = "INIT";
    // Zuletzt empfangener Nutztext vom Tracker (roh, mit Trennzeichen)
    hidden var mValue = "";
    // Derselbe Text, bereits in Zeilen zerlegt
    hidden var mLines as Array<String> = [];
    // Parallel dazu: true, wenn die Zeile nur Ziffern und ':' enthaelt
    hidden var mNumeric as Array = [];
    // Parallel dazu: true, wenn die Zeile weggelassen werden darf
    hidden var mOptional as Array = [];
    // Zeitstempel des letzten Notify (System.getTimer())
    hidden var mLastRxMs = 0;

    hidden var mServiceUuid = null;
    hidden var mCharUuid = null;
    hidden var mDevice = null;
    hidden var mScanning = false;

    // Tracker-ID, an die dieses Geraet gebunden ist (z.B. "t1").
    // null = noch keine Bindung, der naechste gefundene Tracker wird
    // angelernt und dauerhaft gespeichert.
    hidden var mBoundId = null;
    // true, wenn die Bindung aus der Einstellung in Garmin Connect
    // stammt. Solche Bindungen werden nie automatisch verworfen.
    hidden var mForced = false;
    // Kandidat aus dem Scan - wird erst bei erfolgreicher Verbindung
    // zur Bindung befoerdert.
    hidden var mPendingId = null;

    // Zeitpunkt, seit dem ununterbrochen gesucht wird (0 = keine Suche)
    hidden var mSearchStartMs = 0;
    // Zeitpunkt des letzten Wechsels zwischen An- und Aus-Fenster
    hidden var mWindowStartMs = 0;

    // Sammelpuffer fuer mehrteilige Nachrichten und der Zeitpunkt,
    // an dem das erste Byte darin eintraf.
    hidden var mRxBuf = []b;
    hidden var mRxMs  = 0;

    function initialize() {
        BleDelegate.initialize();
        mServiceUuid = Ble.stringToUuid(LT_SERVICE_UUID);
        mCharUuid    = Ble.stringToUuid(LT_CHAR_UUID);
        loadBinding();
    }

    // ------------------------------------------------------------
    //  Start / Stop - wird von LivetrackingCIQApp aufgerufen
    // ------------------------------------------------------------

    // Muss NACH Ble.setDelegate() aufgerufen werden.
    function start() as Void {
        mStatus = "PROF..";
        var profile = {
            :uuid => mServiceUuid,
            :characteristics => [
                {
                    :uuid => mCharUuid,
                    :descriptors => [ Ble.cccdUuid() ]
                }
            ]
        };
        try {
            Ble.registerProfile(profile);
        } catch (e) {
            mStatus = "PROF err";
        }
        if (LT_TEST_TEXT.length() > 0) {
            injectTestText();
        }
    }

    // Aufraeumen beim Beenden der Aktivitaet.
    function stop() as Void {
        try {
            if (mScanning) {
                Ble.setScanState(Ble.SCAN_STATE_OFF);
                mScanning = false;
            }
            if (mDevice != null) {
                Ble.unpairDevice(mDevice);
                mDevice = null;
            }
        } catch (e) {
            // bewusst still - beim Beenden ist ein Fehler egal
        }
    }

    // Taktgeber. Der Delegate hat keine eigene Zeitbasis, deshalb ruft
    // LivetrackingCIQView.compute() diese Methode einmal pro Sekunde
    // auf. Hier wird das Scan-Fenster verwaltet.
    function tick() as Void {
        // Notausgang: Kam ein Anfang, aber kein Abschluss, wird der
        // Puffer trotzdem ausgewertet. Betrifft ungerahmte Sender.
        if (mRxBuf.size() > 0) {
            var wait = System.getTimer() - mRxMs;
            if (wait < 0 || wait > LT_FRAME_MS) {
                flushRx();
            }
        }
        if (LT_TEST_TEXT.length() > 0) {
            // Ohne das haengt nach LT_STALE_MS ein " ?" an der letzten
            // Zeile - im Test irrefuehrend, es kommt ja nichts nach.
            mLastRxMs = System.getTimer();
            return;
        }
        if (mDevice != null) {
            return;                  // verbunden - nichts zu suchen
        }
        if (mSearchStartMs == 0) {
            return;                  // Suche laeuft nicht (z.B. Profilfehler)
        }

        var now = System.getTimer();
        var searching = now - mSearchStartMs;
        if (searching < 0) {
            searching = 0;           // getTimer() laeuft irgendwann ueber
        }

        // Gebundenen, aber dauerhaft abwesenden Tracker freigeben
        if (mBoundId != null && !mForced && searching > LT_FORGET_MS) {
            try {
                Application.Storage.deleteValue(LT_STORAGE_KEY);
            } catch (e) {
                // ignorieren - dann bleibt die Bindung eben bestehen
            }
            mBoundId = null;
        }

        // Phase 1: durchgehend suchen
        if (searching < LT_INITIAL_SCAN_MS) {
            startScan();
            return;
        }

        // Phase 2: getaktet suchen
        var inWindow = now - mWindowStartMs;
        if (inWindow < 0) {
            inWindow = 0;
        }
        if (mScanning) {
            if (inWindow >= LT_SCAN_ON_MS) {
                stopScan();
                mWindowStartMs = now;
            }
        } else {
            if (inWindow >= LT_SCAN_OFF_MS) {
                startScan();
                mWindowStartMs = now;
            }
        }

        // Stabiler Text statt wechselndem SCAN/Pause - sonst flackert
        // die Anzeige im Minutentakt.
        mStatus = "kein Tracker";
    }

    // Wird von der App gerufen, wenn der Nutzer die Einstellungen in
    // Garmin Connect geaendert hat. Die gelernte Bindung wird dabei
    // immer verworfen, damit eine geleerte Einstellung zuverlaessig
    // zurueck in den Automatikbetrieb fuehrt.
    function reloadSettings() as Void {
        try {
            Application.Storage.deleteValue(LT_STORAGE_KEY);
        } catch (e) {
            // ignorieren
        }
        mBoundId   = null;
        mPendingId = null;
        loadBinding();

        if (mDevice != null) {
            try {
                Ble.unpairDevice(mDevice);
            } catch (e) {
                // ignorieren
            }
            mDevice = null;
        }
        mValue    = "";
        mLines    = [];
        mNumeric  = [];
        mOptional = [];
        beginSearch();
    }

    // ------------------------------------------------------------
    //  Anzeige - wird von LivetrackingCIQView.compute() gelesen
    // ------------------------------------------------------------

    // Liefert die anzuzeigenden Zeilen. Solange keine Daten da sind,
    // ist das genau eine Zeile mit dem aktuellen Verbindungsstatus.
    function getLines() as Array<String> {
        if (mValue.length() == 0) {
            return [ mStatus ];
        }
        var age = System.getTimer() - mLastRxMs;
        if (age < 0) {
            age = 0;   // System.getTimer() laeuft irgendwann ueber
        }
        if (age > LT_STALE_MS) {
            // Verbindung steht, aber seit LT_STALE_MS nichts Neues.
            // Kopie anlegen, damit mLines unveraendert bleibt.
            var out = [];
            for (var i = 0; i < mLines.size(); i++) {
                out.add(mLines[i]);
            }
            if (out.size() > 0) {
                out[out.size() - 1] = (out[out.size() - 1] as String) + " ?";
            }
            return out;
        }
        return mLines;
    }

    // Parallel zu getLines(): true, wenn die Zeile in der grossen
    // Ziffernschrift gesetzt werden darf. Statuszeilen und die um " ?"
    // ergaenzte Zeile sind immer false.
    function getNumeric() as Array {
        if (mValue.length() == 0) {
            return [ false ];
        }
        var out = [];
        for (var i = 0; i < mNumeric.size(); i++) {
            out.add(mNumeric[i]);
        }
        var age = System.getTimer() - mLastRxMs;
        if (age < 0) {
            age = 0;
        }
        if (age > LT_STALE_MS && out.size() > 0) {
            out[out.size() - 1] = false;   // wegen des angehaengten " ?"
        }
        return out;
    }

    // Parallel zu getLines(): true, wenn die Zeile bei Platzmangel
    // weggelassen werden darf. Statuszeilen sind nie verzichtbar.
    function getOptional() as Array {
        if (mValue.length() == 0) {
            return [ false ];
        }
        return mOptional;
    }

    // ------------------------------------------------------------
    //  BLE-Callbacks
    // ------------------------------------------------------------

    function onProfileRegister(uuid, status) as Void {
        if (status == Ble.STATUS_SUCCESS) {
            mStatus = "PROF ok";
            beginSearch();
        } else {
            mStatus = "PROF e" + status.toString();
        }
    }

    function onScanStateChange(scanState, status) as Void {
        mScanning = (scanState == Ble.SCAN_STATE_SCANNING);
    }

    function onScanResults(scanResults) as Void {
        for (var r = scanResults.next(); r != null; r = scanResults.next()) {
            if (isOurTracker(r)) {
                mStatus = "FOUND";
                // Kandidat merken - wird erst bei erfolgreicher
                // Verbindung zur dauerhaften Bindung.
                mPendingId = idFromName((r as Ble.ScanResult).getDeviceName());
                try {
                    stopScan();
                    Ble.pairDevice(r as Ble.ScanResult);
                } catch (e) {
                    mStatus = "PAIR err";
                    startScan();
                }
                return;
            }
        }
    }

    function onConnectedStateChanged(device, state) as Void {
        if (state == Ble.CONNECTION_STATE_CONNECTED) {
            mDevice = device;
            mStatus = "CONN";
            // Erste erfolgreiche Verbindung -> Tracker dauerhaft binden.
            if (mBoundId == null && mPendingId != null) {
                mBoundId = mPendingId;
                try {
                    Application.Storage.setValue(LT_STORAGE_KEY, mBoundId);
                } catch (e) {
                    // ignorieren - dann gilt die Bindung nur fuer diese Fahrt
                }
            }
            subscribe();
        } else {
            // Verbindung weg -> aufraeumen und neu suchen
            mStatus = "LOST";
            mValue  = "";
            mLines  = [];
            mNumeric = [];
            mOptional = [];
            mDevice = null;
            try {
                Ble.unpairDevice(device);
            } catch (e) {
                // ignorieren
            }
            beginSearch();
        }
    }

    function onDescriptorWrite(descriptor, status) as Void {
        if (status == Ble.STATUS_SUCCESS) {
            mStatus = "SUB ok";
        } else {
            mStatus = "SUB e" + status.toString();
        }
    }

    function onCharacteristicChanged(characteristic, value) as Void {
        if (!characteristic.getUuid().equals(mCharUuid)) {
            return;
        }
        for (var i = 0; i < value.size(); i++) {
            var c = value[i];
            if (c == LT_STX) {
                // Neue Nachricht - Angefangenes ist unbrauchbar.
                mRxBuf = []b;
                mRxMs  = System.getTimer();
            } else if (c == LT_ETX) {
                flushRx();
            } else if (mRxBuf.size() < LT_RX_MAX) {
                if (mRxBuf.size() == 0) {
                    mRxMs = System.getTimer();
                }
                mRxBuf.add(c);
            }
        }
    }

    // Sammelpuffer auswerten und leeren.
    hidden function flushRx() as Void {
        if (mRxBuf.size() > 0) {
            bytesToLines(mRxBuf);
            mLastRxMs = System.getTimer();
        }
        mRxBuf = []b;
    }

    // ------------------------------------------------------------
    //  Hilfsfunktionen
    // ------------------------------------------------------------

    // Setzt die Suchuhr zurueck und beginnt Phase 1.
    hidden function beginSearch() as Void {
        var now = System.getTimer();
        mSearchStartMs = now;
        mWindowStartMs = now;
        startScan();
    }

    hidden function stopScan() as Void {
        if (!mScanning) {
            return;
        }
        try {
            Ble.setScanState(Ble.SCAN_STATE_OFF);
            mScanning = false;
        } catch (e) {
            // ignorieren - im naechsten tick() wird es erneut versucht
        }
    }

    // Bindung bestimmen. Reihenfolge: Einstellung schlaegt gespeicherte
    // Bindung, gespeicherte Bindung schlaegt Automatik.
    hidden function loadBinding() as Void {
        var forced = null;
        try {
            forced = Application.Properties.getValue(LT_SETTING_KEY);
        } catch (e) {
            forced = null;
        }
        if (forced != null && (forced as String).length() > 0) {
            mBoundId = forced;
            mForced  = true;
            return;
        }
        mForced = false;
        try {
            mBoundId = Application.Storage.getValue(LT_STORAGE_KEY);
        } catch (e) {
            mBoundId = null;
        }
    }

    // "LT-t1" -> "t1". Liefert null, wenn der Name nicht passt.
    hidden function idFromName(name) as String? {
        if (name == null) {
            return null;
        }
        var n = name as String;
        var p = LT_NAME_PREFIX.length();
        if (n.length() <= p) {
            return null;
        }
        if (!n.substring(0, p).equals(LT_NAME_PREFIX)) {
            return null;
        }
        return n.substring(p, n.length());
    }

    hidden function startScan() as Void {
        if (mScanning) {
            return;
        }
        try {
            Ble.setScanState(Ble.SCAN_STATE_SCANNING);
            mScanning = true;
            mStatus = "SCAN";
        } catch (e) {
            mStatus = "SCAN err";
        }
    }

    // Zwei Betriebsarten:
    //
    // GEBUNDEN: nur der eigene Tracker zaehlt, erkannt am Namen. Die
    //   Service-UUID darf hier NICHT genuegen - die haben alle Tracker
    //   im Feld gemeinsam, sonst verbindet sich der Edge im Startbereich
    //   mit dem Rad daneben.
    //
    // UNGEBUNDEN: jeder Tracker des Projekts wird angenommen und beim
    //   Verbinden angelernt. Hier greift wieder der doppelte Filter,
    //   denn getServiceUuids() liefert auf mancher Hardware einen
    //   leeren Iterator, obwohl korrekt advertised wird.
    hidden function isOurTracker(r) as Boolean {
        var id = idFromName(r.getDeviceName());

        if (mBoundId != null) {
            return (id != null && id.equals(mBoundId as String));
        }

        if (id != null) {
            return true;
        }
        var it = r.getServiceUuids();
        if (it != null) {
            for (var u = it.next(); u != null; u = it.next()) {
                if (u.equals(mServiceUuid)) {
                    return true;
                }
            }
        }
        return false;
    }

    // CCCD beschreiben -> Notifications einschalten.
    hidden function subscribe() as Void {
        if (mDevice == null) {
            return;
        }
        var svc = mDevice.getService(mServiceUuid);
        if (svc == null) {
            mStatus = "NO SVC";
            return;
        }
        var ch = svc.getCharacteristic(mCharUuid);
        if (ch == null) {
            mStatus = "NO CHR";
            return;
        }
        var cccd = ch.getDescriptor(Ble.cccdUuid());
        if (cccd == null) {
            mStatus = "NO CCCD";
            return;
        }
        try {
            // 0x01,0x00 = Notify einschalten (0x02,0x00 waere Indicate)
            cccd.requestWrite([0x01, 0x00]b);
            mStatus = "SUB..";
        } catch (e) {
            mStatus = "SUB err";
        }
    }

    // ByteArray -> Zeilen. Die Nutzlast ist reiner ASCII-Text,
    // deshalb bewusst manuell statt ueber StringUtil. Am Trennzeichen
    // wird direkt beim Dekodieren eine neue Zeile begonnen; so brauchen
    // wir keine String-Split-Funktion, deren Verfuegbarkeit je nach
    // Connect-IQ-Version schwankt.
    // Schiebt LT_TEST_TEXT durch denselben Parser, den auch ein echtes
    // Notify durchlaeuft. Der Umweg ueber die ByteArray-Schleife ist
    // Absicht: toUtf8Array() liefert Array<Number>, bytesToLines()
    // erwartet aber ByteArray.
    hidden function injectTestText() as Void {
        var u  = LT_TEST_TEXT.toUtf8Array();
        var ba = []b;
        for (var i = 0; i < u.size(); i++) {
            ba.add(u[i]);
        }
        bytesToLines(ba);
        mLastRxMs = System.getTimer();
        mStatus   = "TEST";
    }

    hidden function bytesToLines(b as ByteArray) as Void {
        var lines = [];
        var nums  = [];
        var opts  = [];
        var cur = "";
        var raw = "";
        var curNum = true;   // bleibt true, solange nur Ziffern und ':' kamen
        var curOpt = false;  // gilt fuer die GERADE gesammelte Zeile
        for (var i = 0; i < b.size(); i++) {
            var c = b[i];
            if (c == LT_SEPARATOR || c == LT_SEP_OPT) {
                if (cur.length() > 0 && lines.size() < LT_MAX_LINES) {
                    lines.add(cur);
                    nums.add(curNum);
                    opts.add(curOpt);
                }
                cur = "";
                curNum = true;
                // '~' markiert die FOLGENDE Zeile als verzichtbar
                curOpt = (c == LT_SEP_OPT);
                raw += (c == LT_SEP_OPT) ? "~" : ";";
            } else if (c >= 32 && c < 127) {
                var ch = c.toChar().toString();
                cur += ch;
                raw += ch;
                if (c < LT_DIGIT_MIN || c > LT_DIGIT_MAX) {
                    curNum = false;
                }
            }
        }
        if (cur.length() > 0 && lines.size() < LT_MAX_LINES) {
            lines.add(cur);
            nums.add(curNum);
            opts.add(curOpt);
        }
        mLines    = lines;
        mNumeric  = nums;
        mOptional = opts;
        // Wenn nur Trennzeichen ankamen, gilt die Nachricht als leer.
        mValue = (lines.size() > 0) ? raw : "";
    }

}
