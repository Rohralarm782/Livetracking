/*
 * ============================================================
 *  LivetrackingCIQUploader.mc                             (v1)
 * ============================================================
 *  Schickt die eigene GPS-Position ueber das gekoppelte Handy
 *  an den Livetracking-Server. Gedacht fuer Sportler im
 *  Training, damit dort keine eigene Handy-App noetig ist.
 *
 *  Weg der Daten:
 *      Edge -> BLE -> Garmin Connect (Handy) -> Internet
 *  Genau der Weg, den Garmins eigenes LiveTrack nimmt. Das
 *  Handy muss also dabei sein, Garmin Connect muss laufen.
 *
 *  Bewusst als eigene Klasse, getrennt vom BleDelegate: das
 *  Anzeigefeld ist im Rennen betriebskritisch und darf durch
 *  das Trainings-Feature kein Risiko bekommen. Beruehrung mit
 *  dem Rest der App gibt es nur an zwei Stellen - Erzeugung in
 *  LivetrackingCIQApp und ein Aufruf von onCompute() in der
 *  View.
 *
 *  Zwei getrennte Takte:
 *    Abtastung  alle LT_UP_SAMPLE_S Sekunden, rein lokal.
 *               Bestimmt die Punktdichte auf der Karte und
 *               kostet nichts.
 *    Versand    alle mIntervalS Sekunden als Stapel. Nur
 *               dieser Takt belastet BLE und Funk und ist der
 *               einzige, den Garmin drosseln koennte.
 *
 *  Faellt die Verbindung aus, sammeln sich die Punkte im
 *  Puffer und gehen beim naechsten erfolgreichen Request
 *  gemeinsam raus. Der Puffer ist gedeckelt; laeuft er voll,
 *  fliegt der aelteste Punkt heraus.
 *
 *  Zeitstempel gehen in SEKUNDEN seit Epoche raus, nicht in
 *  Millisekunden: Monkey C rechnet mit 32-Bit-Ganzzahlen, eine
 *  Millisekunden-Epoche passt dort nicht hinein. Der Server
 *  erkennt das an der Groessenordnung und rechnet um.
 * ============================================================
 */

import Toybox.Activity;
import Toybox.Application;
import Toybox.Communications;
import Toybox.Lang;
import Toybox.System;
import Toybox.Time;

// Fest einkompiliert statt als Einstellung: eine vertippte URL
// waere fuer den Sportler nicht diagnostizierbar.
const LT_UP_URL = "https://livetracking-fq4l.onrender.com/positions";

// Schluessel der Einstellungen aus Garmin Connect
const LT_UP_ID_KEY  = "uploadId";
const LT_UP_INT_KEY = "uploadIntervalS";

const LT_UP_SAMPLE_S     = 5;    // Abtastabstand
const LT_UP_MAX_POINTS   = 120;  // Puffergroesse = 10 min Rueckstand
const LT_UP_BATCH_MAX    = 30;   // Punkte je Request
const LT_UP_INT_MIN      = 5;
const LT_UP_INT_MAX      = 120;
const LT_UP_INT_DEFAULT  = 20;
const LT_UP_BACKOFF_MAX  = 120;  // Sekunden

class LivetrackingCIQUploader {

    hidden var mId        as String? = null;
    hidden var mIntervalS as Number  = LT_UP_INT_DEFAULT;

    hidden var mBuf as Array = [];

    hidden var mLastSampleS as Number  = 0;
    hidden var mLastSendS   as Number  = 0;
    hidden var mBackoffS    as Number  = 0;
    hidden var mInFlight    as Boolean = false;
    hidden var mSentCount   as Number  = 0;

    function initialize() {
        reloadSettings();
    }

    function start() as Void {
        mBuf         = [];
        mLastSampleS = 0;
        mLastSendS   = 0;
        mBackoffS    = 0;
        mInFlight    = false;
        mSentCount   = 0;
    }

    function stop() as Void {
        mBuf       = [];
        mInFlight  = false;
        mSentCount = 0;
    }

    // Aus Garmin Connect nachgeladen. Leere Upload-ID heisst: der
    // Nutzer will keinen Upload - dann bleibt die Klasse still.
    function reloadSettings() as Void {
        var id = null;
        try {
            id = Application.Properties.getValue(LT_UP_ID_KEY);
        } catch (e) {
            id = null;
        }
        if (id != null && (id as String).length() > 0) {
            mId = id as String;
        } else {
            mId = null;
        }

        var iv = null;
        try {
            iv = Application.Properties.getValue(LT_UP_INT_KEY);
        } catch (e) {
            iv = null;
        }
        if (iv != null && iv instanceof Lang.Number) {
            mIntervalS = iv as Number;
        } else {
            mIntervalS = LT_UP_INT_DEFAULT;
        }
        if (mIntervalS < LT_UP_INT_MIN) { mIntervalS = LT_UP_INT_MIN; }
        if (mIntervalS > LT_UP_INT_MAX) { mIntervalS = LT_UP_INT_MAX; }
    }

    // Sekundentakt aus der View. Ein Datenfeld hat keine eigene
    // Zeitbasis - compute() ist die einzige regelmaessige Quelle.
    // Gemessen wird trotzdem an der Uhr, nicht an der Zahl der
    // Aufrufe: compute() kann aussetzen.
    function onCompute(info as Activity.Info) as Void {
        if (mId == null) {
            return;
        }
        if (!isRecording(info)) {
            return;
        }

        var nowS = Time.now().value();

        if (nowS - mLastSampleS >= LT_UP_SAMPLE_S) {
            sample(info, nowS);
            mLastSampleS = nowS;
        }

        if (mInFlight || mBuf.size() <= 0) {
            return;
        }
        if (nowS - mLastSendS < mIntervalS + mBackoffS) {
            return;
        }
        // Ohne Handyverbindung gar nicht erst starten. mLastSendS
        // bleibt stehen, damit sofort gesendet wird, sobald das
        // Handy wieder da ist.
        if (!System.getDeviceSettings().connectionAvailable) {
            return;
        }
        send(nowS);
    }

    // Pause zaehlt mit: bei Auto-Pause an der Ampel steht der
    // Fahrer weiterhin auf der Karte, statt aus ihr zu
    // verschwinden. Ohne laufende Aufzeichnung dagegen laeuft
    // compute() ohnehin nicht.
    hidden function isRecording(info as Activity.Info) as Boolean {
        var st = info.timerState;
        if (st == null) {
            return false;
        }
        return (st == Activity.TIMER_STATE_ON) || (st == Activity.TIMER_STATE_PAUSED);
    }

    // Fuenf Nachkommastellen sind rund 1 m - feiner braucht es
    // die Karte nicht, und jede Stelle mehr kostet Nutzlast.
    hidden function round5(v) as Float {
        return ((v * 100000).toNumber()) / 100000.0;
    }

    hidden function sample(info as Activity.Info, nowS as Number) as Void {
        var loc = info.currentLocation;
        if (loc == null) {
            return;
        }
        var d = loc.toDegrees();
        if (d == null || d.size() < 2) {
            return;
        }

        var p = {
            "lat" => round5(d[0]),
            "lon" => round5(d[1]),
            "ts"  => nowS
        };
        var sp = info.currentSpeed;
        if (sp != null && sp >= 0) {
            p.put("spd", ((sp * 10).toNumber()) / 10.0);
        }

        mBuf.add(p);
        while (mBuf.size() > LT_UP_MAX_POINTS) {
            mBuf = mBuf.slice(1, null);
        }
    }

    hidden function send(nowS as Number) as Void {
        var n = mBuf.size();
        if (n > LT_UP_BATCH_MAX) {
            n = LT_UP_BATCH_MAX;
        }

        mSentCount = n;
        mInFlight  = true;
        mLastSendS = nowS;

        // ID nur einmal statt an jedem Punkt - spart Nutzlast.
        var body = {
            "id"     => mId,
            "points" => mBuf.slice(0, n)
        };
        var opts = {
            :method       => Communications.HTTP_REQUEST_METHOD_POST,
            :headers      => { "Content-Type" => Communications.REQUEST_CONTENT_TYPE_JSON },
            :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON
        };
        Communications.makeWebRequest(LT_UP_URL, body, opts, method(:onReceive));
    }

    // Nur die tatsaechlich uebertragenen Punkte entfernen. Ein
    // clear() wuerde die Punkte mitreissen, die waehrend des
    // laufenden Requests dazugekommen sind.
    function onReceive(code as Number, data) as Void {
        mInFlight = false;

        if (code == 200 || code == 204) {
            var n = mSentCount;
            if (n > mBuf.size()) {
                n = mBuf.size();
            }
            if (n > 0) {
                mBuf = mBuf.slice(n, null);
            }
            mBackoffS = 0;
        } else {
            // Verdoppeln statt stur weiterversuchen: bei Funkloch
            // oder Drosselung waere jeder Versuch verlorene Zeit
            // und Akku.
            if (mBackoffS <= 0) {
                mBackoffS = mIntervalS;
            } else {
                mBackoffS = mBackoffS * 2;
            }
            if (mBackoffS > LT_UP_BACKOFF_MAX) {
                mBackoffS = LT_UP_BACKOFF_MAX;
            }
        }

        mSentCount = 0;
    }

}
