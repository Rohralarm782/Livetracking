# Livetracking – Update 1 + Update 2, fertig eingebaut

Stand vom 17.08.2026, aufgesetzt auf den Repo-Stand von
`codeload.github.com/Rohralarm782/Livetracking/zip/refs/heads/main`.

Dieser Ordner ist ein vollstaendiger Ersatz-Satz: Update 1 (Fehlerbehebungen)
und Update 2 (neue Features) sind beide bereits eingearbeitet.

## Hochladen

Alle Dateien und die drei Unterordner `core/`, `css/`, `map/`, `race/` in
**einem** Vorgang bei GitHub hochladen, dann loest das genau einen Deploy aus.
Die Ordnerstruktur muss erhalten bleiben.

`AENDERUNGEN.md` (diese Datei) darf mit hoch oder auch nicht — sie wird von
nichts referenziert.

## Was sich geaendert hat

| Datei | ersetzt | neu | |
|---|---:|---:|---|
| `server.js` | 18 | 318 | geaendert |
| `map/map.js` | 19 | 106 | geaendert |
| `race/favorites.js` | 7 | 132 | geaendert |
| `race/taktik.js` | 1 | 93 | geaendert |
| `race/startlists.js` | 1 | 58 | geaendert |
| `race/taktik-ui.js` | 10 | 52 | geaendert |
| `race/events.js` | 0 | 36 | geaendert |
| `css/app.css` | 0 | 35 | geaendert |
| `race/displays.js` | 3 | 26 | geaendert |
| `index.html` | 3 | 17 | geaendert |
| `race/events-ui.js` | 0 | 13 | geaendert |
| `db.js` | 0 | 4 | geaendert |
| **Gesamt** | **62** | **890** | |

**Unveraendert** und nur der Vollstaendigkeit halber dabei:
`core/app.js`, `core/auth.js`, `core/ui.js`, `map/gpx.js`, `sw.js`,
`manifest.json`, `package.json`, `package-lock.json`, `icon.svg`, `README.md`.

## Neue Umgebungsvariable (optional)

`TRACKER_KEY` — ist sie bei Render gesetzt, verlangt `POST /positions` den
Header `x-tracker-key`. Ist sie **nicht** gesetzt, verhaelt sich der Endpoint
wie bisher. Ein Deploy ohne die Variable kann also nichts kaputtmachen.
Die Tracker senden ueber MQTT, sind davon also nicht betroffen.

## Neu in der Bedienung

- **Optionsmenue:** Knopf „🗺 Karte: Voyager" schaltet zwischen CartoDB
  Voyager (Vorgabe) und OSM-Standard um. Die Wahl bleibt im Browser gespeichert.
- **Fahrerzeile in der Taktik:** kleiner Knopf hinter dem Stern schaltet durch
  normal → ⚠ verwarnt → DSQ → DNF → normal. DSQ und DNF nehmen den Fahrer aus
  der Gruppengroesse und vom Garmin, er bleibt aber durchgestrichen sichtbar.
- **Favoriten-Modal:** Knopf „✎ Startliste bearbeiten" schaltet den
  Bearbeitungsmodus frei — Fahrer ergaenzen, aendern, entfernen. Wird eine
  Startnummer korrigiert oder ein Fahrer geloescht, zieht die Gruppe mit.
- **Rennzeile:** ⧉ kopiert ein Rennen mit gleicher Startliste, ohne Gruppen und
  ohne Strecke.
- **Gruppenkarte:** unter dem Abstand steht die Annaeherungsrate, z.B.
  „▼ 8 s/min · dran in ~11 min". Erscheint erst, wenn genug Messpunkte da sind.
- **Import:** findet die KI keine Fahrer, fragt sie nach, welche Kategorien in
  der Datei stehen, und bietet sie als anklickbare Knoepfe an.
- **Karte:** Marker, die seit ueber 3 Minuten nichts gemeldet haben, werden
  abgeblendet und zeigen ihr Alter im Tooltip. Der Auto-Zoom ignoriert sie —
  ebenso Betreuer-Marker.

## Erster Start nach dem Deploy

Der Server liest jetzt zusaetzlich einen Schluessel `runtime` aus der
`settings`-Tabelle. Beim ersten Start gibt es den noch nicht, das ist normal
und wird still uebergangen. Ab dem ersten Umschalten von Automatik, Modus oder
Anzeigename wird er geschrieben und ueberlebt danach jeden Cold Start.

Die `gap_history` bekommt ab jetzt die Gruppen-ID in den Snapshot. Aeltere
Eintraege ohne ID werden bei der Annaeherungsrate uebersprungen — nach ein paar
Minuten Rennen ist genug Neues da.

## Geprueft

Alle 15 JS-Dateien syntaktisch fehlerfrei, keine doppelten globalen Namen,
alle `getElementById`-IDs vorhanden, alle benutzten CSS-Klassen definiert.
Am laufenden Server durchgetestet:

- Automatiktext `3x 1:30~7,12,33;HF` → nach DSQ von 12 → `2x 1:30~7,33;HF`
- kaputte Gruppen (`[null,"x",{riders:"nein"}]`) werden bereinigt statt
  angenommen; `/groups` und `/displays` antworten danach weiter mit 200
- `/server.js` und `/db.js` → 404, `/index.html` und `/css/app.css` → 200
- Fahrer ergaenzt, Nr. 33 → 34 korrigiert (Gruppe zog mit: `[7, 34]`),
  Fahrer 41 geloescht (aus Startliste und Gruppe verschwunden)
- Rennen kopiert, Abstandsverlauf antwortet auch ohne Datenbank sauber
- Betreuer-Token auf `/api/claude` und `/rider-status` → jeweils 403

## Ausfuehrliche Beschreibung

Die drei Dokumente aus dem Audit erklaeren jede einzelne Aenderung mit
Begruendung:

- `BEFUND-Codeaudit.md` — was gefunden wurde und warum es zaehlt
- `UPDATE-1-Patches.md` — 35 Patches, Fehlerbehebungen
- `UPDATE-2-Features.md` — 30 Patches, neue Features, plus Vorschlaege fuer
  spaeter
