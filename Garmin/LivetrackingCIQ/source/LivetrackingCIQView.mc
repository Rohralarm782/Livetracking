/*
 * ============================================================
 *  LivetrackingCIQView.mc                                 (v9)
 * ============================================================
 *  v1-v4: siehe Historie in v5.
 *  v5: Schriftwahl pro ZEILE - Zeilen aus reinen Ziffern
 *      bekamen FONT_NUMBER_*, alle anderen Textschrift.
 *  v6: Schriftwahl pro SEGMENT innerhalb einer Zeile.
 *      "6 0:15" wird zerlegt in Ziffernblock, Leerzeichen,
 *      Ziffernblock - die Zahlen erscheinen gross, obwohl die
 *      Zeile als Ganzes keine reine Ziffernzeile ist.
 *
 *      Dazu Platzmanagement in zwei Stufen:
 *        1. Schrift verkleinern, aber NIE unter FONT_SMALL.
 *        2. Reicht das nicht, Inhalt weglassen und wieder
 *           mit der groessten Schrift beginnen.
 *      Rangfolge beim Weglassen:
 *        a) optionale Zeilen (Startnummern, '~' im Protokoll)
 *        b) hintere Gruppen, ersetzt durch "..."
 *      Die erste Zeile bleibt immer stehen.
 *
 *      Grund: unlesbar kleine Schrift nuetzt auf dem Lenker
 *      niemandem - lieber weniger anzeigen, dafuer lesbar.
 *  v7: Zusammenfuehrung mit dem Bindungs-Zweig. compute() ist
 *      nicht mehr leer, sondern Sekundentakt fuer die
 *      Scan-Steuerung im Delegate (siehe dort tick()).
 *  v8: Leerzeichen am Segmentrand bekommen eine eigene Breite.
 *      Garmin verwirft Randweissraum beim Messen UND beim
 *      Zeichnen, ein Segment aus reinem Weissraum misst deshalb
 *      0 - doppelte Leerzeichen blieben wirkungslos. Jetzt wird
 *      der Randweissraum selbst gezaehlt und mit einem Drittel
 *      Zifferbreite je Zeichen veranschlagt, skaliert also mit
 *      der Schriftstufe mit.
 *  v9: Einstiegsstufe haengt vom Inhalt ab. Die Stufen 0-3 sind
 *      fuer zifferngefuehrte Zeilen gedacht; Text ist dort
 *      absichtlich klein, damit sich das 'x' in "6x 0:15" der
 *      Zahl unterordnet. Reiner Text passte deshalb schon auf
 *      Stufe 0 und bekam FONT_MEDIUM, obwohl Stufe 4 FONT_LARGE
 *      geboten haette. Ohne Ziffern beginnt die Suche jetzt bei
 *      LT_TEXT_LEVEL.
 * ============================================================
 */

import Toybox.Activity;
import Toybox.Graphics;
import Toybox.Lang;
import Toybox.WatchUi;

// Ab dieser Stufe gelten fuer Ziffern und Text dieselben
// Schriften. Darunter liegen die reinen Zifferngroessen, die fuer
// Buchstaben nichts hergeben - FONT_NUMBER_* enthaelt nur Ziffern
// und Doppelpunkt, ein 'M' erschiene als leeres Kaestchen.
const LT_TEXT_LEVEL = 4;

class LivetrackingCIQView extends WatchUi.DataField {

    hidden var mBle as LivetrackingCIQBleDelegate? = null;

    // Groessenstufen, parallel: Index i gehoert zusammen.
    // Ziffernsegmente nehmen mNumFonts[i], Text mTxtFonts[i].
    hidden var mNumFonts as Array = [
        Graphics.FONT_NUMBER_THAI_HOT,
        Graphics.FONT_NUMBER_HOT,
        Graphics.FONT_NUMBER_MEDIUM,
        Graphics.FONT_NUMBER_MILD,
        Graphics.FONT_LARGE,
        Graphics.FONT_MEDIUM,
        Graphics.FONT_SMALL
    ];
    hidden var mTxtFonts as Array = [
        Graphics.FONT_MEDIUM,
        Graphics.FONT_MEDIUM,
        Graphics.FONT_SMALL,
        Graphics.FONT_SMALL,
        Graphics.FONT_LARGE,
        Graphics.FONT_MEDIUM,
        Graphics.FONT_SMALL
    ];
    // Optionale Zeilen (Startnummern) duerfen kleiner sein,
    // aber ebenfalls nicht unter FONT_SMALL.
    hidden var mOptFonts as Array = [
        Graphics.FONT_SMALL,
        Graphics.FONT_SMALL,
        Graphics.FONT_SMALL,
        Graphics.FONT_SMALL,
        Graphics.FONT_SMALL,
        Graphics.FONT_SMALL,
        Graphics.FONT_SMALL
    ];

    hidden var mCacheKey   = "";
    hidden var mCacheLevel = -1;
    hidden var mCacheDrop  = 0;

    function initialize(bleDelegate as LivetrackingCIQBleDelegate?) {
        DataField.initialize();
        mBle = bleDelegate;
    }

    // Die Daten kommen asynchron per BLE, nicht aus Activity.Info -
    // compute() dient hier ausschliesslich als Sekundentakt fuer die
    // Scan-Steuerung im Delegate, der keine eigene Zeitbasis hat.
    function compute(info as Activity.Info) as Void {
        if (mBle != null) {
            mBle.tick();
        }
    }

    function onUpdate(dc as Dc) as Void {
        var bg = getBackgroundColor();
        var fg = (bg == Graphics.COLOR_BLACK) ? Graphics.COLOR_WHITE : Graphics.COLOR_BLACK;

        dc.setColor(bg, bg);
        dc.clear();
        dc.setColor(fg, Graphics.COLOR_TRANSPARENT);

        var lines = [ "NO BLE" ];
        var nums  = [ false ];
        var opts  = [ false ];
        if (mBle != null) {
            lines = mBle.getLines();
            nums  = mBle.getNumeric();
            opts  = mBle.getOptional();
        }
        if (lines.size() <= 0) {
            return;
        }
        // Sicherheitsnetz: alle drei Arrays gleich lang halten
        while (nums.size() < lines.size()) { nums.add(false); }
        while (opts.size() < lines.size()) { opts.add(false); }

        var w = dc.getWidth();
        var h = dc.getHeight();
        var padX = w / 20;
        var padY = h / 20;
        if (padX < 3) { padX = 3; }
        if (padY < 2) { padY = 2; }
        var maxW = w - 2 * padX;
        var maxH = h - 2 * padY;

        var key = w.toString() + "x" + h.toString();
        for (var i = 0; i < lines.size(); i++) {
            key = key + "|" + (lines[i] as String);
        }
        if (!key.equals(mCacheKey) || mCacheLevel < 0) {
            fitContent(dc, lines, nums, opts, maxW, maxH);
            mCacheKey = key;
        }

        var shown = applyDrop(lines, nums, opts, mCacheDrop);
        var sl = shown[0];
        var sn = shown[1];
        var so = shown[2];
        var n  = sl.size();
        if (n <= 0) {
            return;
        }

        var total = 0;
        for (var j = 0; j < n; j++) {
            total = total + lineHeight(dc, sl[j] as String, sn[j], so[j], mCacheLevel);
        }

        var y = (h - total) / 2;
        if (y < 0) { y = 0; }
        for (var j = 0; j < n; j++) {
            var lh = lineHeight(dc, sl[j] as String, sn[j], so[j], mCacheLevel);
            drawMixed(dc, w / 2, y, sl[j] as String, sn[j], so[j], mCacheLevel, lh);
            y = y + lh;
        }
    }

    // ------------------------------------------------------------
    //  Platzmanagement
    // ------------------------------------------------------------

    // Erst Schrift verkleinern (bis zur Untergrenze), dann Inhalt
    // weglassen und wieder mit der groessten Schrift beginnen.
    // Ergebnis landet in mCacheLevel und mCacheDrop.
    hidden function fitContent(dc as Dc, lines, nums, opts, maxW, maxH) as Void {
        for (var drop = 0; drop <= 2; drop++) {
            var v  = applyDrop(lines, nums, opts, drop);
            var vl = v[0];
            var vn = v[1];
            var vo = v[2];
            if (vl.size() <= 0) {
                continue;
            }
            // Ohne Ziffern bringen die Stufen unterhalb LT_TEXT_LEVEL
            // nichts - dort ist die Textschrift kleiner als auf 4.
            var start = hasDigits(vl, vo) ? 0 : LT_TEXT_LEVEL;
            for (var lvl = start; lvl < mNumFonts.size(); lvl++) {
                if (fitsAll(dc, vl, vn, vo, lvl, maxW, maxH)) {
                    mCacheLevel = lvl;
                    mCacheDrop  = drop;
                    return;
                }
            }
        }
        // Nichts passt: kleinste Stufe, maximal reduziert
        mCacheLevel = mNumFonts.size() - 1;
        mCacheDrop  = 2;
    }

    // drop 0 = alles
    // drop 1 = optionale Zeilen weg
    // drop 2 = zusaetzlich nur erste Zeile + "..."
    hidden function applyDrop(lines, nums, opts, drop) {
        if (drop <= 0) {
            return [ lines, nums, opts ];
        }
        // Cast statt Annotation: lokale Typen werden inferiert, und aus
        // dem leeren Literal leitet der Pruefer sonst die Laenge 0 ab -
        // ol[0] weiter unten gilt dann als Zugriff ausserhalb des Arrays.
        var ol = [] as Array;
        var on = [] as Array;
        var oo = [] as Array;
        for (var i = 0; i < lines.size(); i++) {
            if (opts[i] == true) {
                continue;
            }
            ol.add(lines[i]);
            on.add(nums[i]);
            oo.add(opts[i]);
        }
        if (drop == 1) {
            return [ ol, on, oo ];
        }
        // drop 2: nur die erste Zeile behalten, Rest als Auslassung
        var fl = [];
        var fn = [];
        var fo = [];
        if (ol.size() > 0) {
            fl.add(ol[0]);
            fn.add(on[0]);
            fo.add(false);
        }
        if (ol.size() > 1) {
            fl.add("...");
            fn.add(false);
            fo.add(false);
        }
        return [ fl, fn, fo ];
    }

    hidden function fitsAll(dc as Dc, lines, nums, opts, lvl, maxW, maxH) {
        var total = 0;
        for (var j = 0; j < lines.size(); j++) {
            var txt = lines[j] as String;
            if (lineWidth(dc, txt, nums[j], opts[j], lvl) > maxW) {
                return false;
            }
            total = total + lineHeight(dc, txt, nums[j], opts[j], lvl);
        }
        return total <= maxH;
    }

    // ------------------------------------------------------------
    //  Segmentierung: Ziffernbloecke gross, Rest klein
    // ------------------------------------------------------------

    // Zerlegt eine Zeile in Abschnitte gleicher Art.
    // Rueckgabe: Array aus [text, istZiffernblock].
    // Enthaelt irgendeine Pflichtzeile eine Ziffer? Optionale Zeilen
    // zaehlen nicht mit - die laufen ohnehin ueber mOptFonts und
    // duerfen die Stufenwahl der Hauptzeilen nicht bestimmen.
    hidden function hasDigits(lines as Array, opts as Array) {
        for (var i = 0; i < lines.size(); i++) {
            if (opts[i] == true) {
                continue;
            }
            var ch = (lines[i] as String).toCharArray();
            for (var j = 0; j < ch.size(); j++) {
                var cv = ch[j].toNumber();
                if (cv >= 48 && cv <= 57) {
                    return true;
                }
            }
        }
        return false;
    }

    // Ersatzbreite fuer ein Leerzeichen. Ein Drittel Zifferbreite ist
    // schmal genug, um nicht als Luecke zu wirken, und breit genug, um
    // Anzahl und Abstand sichtbar zu trennen. Waechst mit der Schrift.
    hidden function gapUnit(dc as Dc, f) {
        return dc.getTextWidthInPixels("0", f) / 3;
    }

    hidden function leadSpaces(txt as String) {
        var ch = txt.toCharArray();
        var n  = 0;
        while (n < ch.size() && ch[n].toNumber() == 32) {
            n++;
        }
        return n;
    }

    hidden function trailSpaces(txt as String) {
        var ch   = txt.toCharArray();
        var lead = leadSpaces(txt);
        if (lead >= ch.size()) {
            return 0;   // reiner Weissraum - steckt schon in leadSpaces()
        }
        var n = 0;
        var j = ch.size() - 1;
        while (j >= 0 && ch[j].toNumber() == 32) {
            n++;
            j--;
        }
        return n;
    }

    // Breite eines Segments einschliesslich seiner Randleerzeichen.
    // Weissraum INNERHALB des Segments misst Garmin korrekt, nur am
    // Rand faellt er weg - deshalb wird nur dieser nachgetragen.
    hidden function segWidth(dc as Dc, txt as String, f) {
        var w = dc.getTextWidthInPixels(txt, f);
        var n = leadSpaces(txt) + trailSpaces(txt);
        if (n > 0) {
            w = w + n * gapUnit(dc, f);
        }
        return w;
    }

    hidden function segments(line as String, isNum, isOpt) {
        var out = [];
        // Optionale Zeilen und reine Ziffernzeilen brauchen keine
        // Zerlegung - sie bestehen ohnehin aus einem Stueck.
        if (isOpt == true) {
            out.add([ line, false ]);
            return out;
        }
        if (isNum == true) {
            out.add([ line, true ]);
            return out;
        }
        var chars = line.toCharArray();
        var cur   = "";
        var curIsNum = false;
        var started  = false;
        for (var i = 0; i < chars.size(); i++) {
            var c  = chars[i];
            var cv = c.toNumber();
            // '0'-'9' = 48-57, ':' = 58
            var thisNum = (cv >= 48 && cv <= 58);
            if (!started) {
                curIsNum = thisNum;
                started  = true;
            } else if (thisNum != curIsNum) {
                out.add([ cur, curIsNum ]);
                cur = "";
                curIsNum = thisNum;
            }
            cur += c.toString();
        }
        if (cur.length() > 0) {
            out.add([ cur, curIsNum ]);
        }
        return out;
    }

    hidden function fontForSeg(segIsNum, isOpt, lvl) {
        if (isOpt == true) {
            return mOptFonts[lvl];
        }
        if (segIsNum == true) {
            return mNumFonts[lvl];
        }
        return mTxtFonts[lvl];
    }

    hidden function lineWidth(dc as Dc, line as String, isNum, isOpt, lvl) {
        var segs = segments(line, isNum, isOpt);
        var wsum = 0;
        for (var i = 0; i < segs.size(); i++) {
            var seg = segs[i];
            wsum = wsum + segWidth(dc, seg[0] as String, fontForSeg(seg[1], isOpt, lvl));
        }
        return wsum;
    }

    hidden function lineHeight(dc as Dc, line as String, isNum, isOpt, lvl) {
        var segs = segments(line, isNum, isOpt);
        var hmax = 0;
        for (var i = 0; i < segs.size(); i++) {
            var seg = segs[i];
            var fh  = dc.getFontHeight(fontForSeg(seg[1], isOpt, lvl));
            if (fh > hmax) { hmax = fh; }
        }
        return hmax;
    }

    // Zeichnet die Segmente nebeneinander, zentriert, auf
    // gemeinsamer Grundlinie. Connect IQ liefert nur die
    // Gesamthoehe einer Schrift, keinen Grundlinienabstand -
    // deshalb wird ueber die Hoehendifferenz ausgerichtet.
    hidden function drawMixed(dc as Dc, cx, y, line as String, isNum, isOpt, lvl, lh) as Void {
        var segs = segments(line, isNum, isOpt);
        var total = lineWidth(dc, line, isNum, isOpt, lvl);
        var x = cx - total / 2;
        for (var i = 0; i < segs.size(); i++) {
            var seg = segs[i];
            var f   = fontForSeg(seg[1], isOpt, lvl);
            var txt = seg[0] as String;
            var dy  = (lh - dc.getFontHeight(f)) / 2;
            // drawText() setzt den ersten sichtbaren Buchstaben an x und
            // schluckt fuehrenden Weissraum. Den Versatz legen wir selbst
            // davor, damit Zeichnen und Messen dasselbe ergeben.
            var lg  = leadSpaces(txt) * gapUnit(dc, f);
            dc.drawText(x + lg, y + dy, f, txt, Graphics.TEXT_JUSTIFY_LEFT);
            x = x + segWidth(dc, txt, f);
        }
    }

}
