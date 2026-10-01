# Plaude – Aufnahmen, Transkript, Zusammenfassung & To-dos

Kleine Web-App fürs Handy: Gespräche aufnehmen, sauber transkribieren lassen und pro **Ordner**
(z. B. „Einkauf Baumarkt 14:30“) eine gemeinsame Zusammenfassung mit Stichpunkten und To-dos bekommen.
Jedes To-do lässt sich per Knopfdruck an die eigene To-do-App schicken.

## So funktioniert's

1. **Ordner anlegen** (oder „Sofort aufnehmen“ – dann heißt der Ordner nach Datum und Uhrzeit).
2. **Aufnehmen** – beliebig viele Aufnahmen pro Ordner. Vorhandene Audiodateien (z. B. Sprachmemos) lassen sich auch hinzufügen.
3. **Transkription**: Lange Aufnahmen werden automatisch in 8-Minuten-Stücke geteilt und mit OpenAI
   `gpt-4o-transcribe` in Text umgewandelt. Danach bessert Claude den Text nach: Erkennungsfehler, Zeichensetzung, Absätze, Füllwörter.
   Den Originaltext gibt es weiterhin unter „Original-Erkennung“.
4. **Zusammenfassung** über *alle* Aufnahmen des Ordners mit Claude: Kurzfassung, Stichpunkte nach Themen,
   To-dos (mit „wer“ und „bis wann“), Entscheidungen und offene Fragen.
5. **To-dos abhaken** oder mit dem Pfeil-Knopf an die To-do-App senden (einzeln oder „Alle offenen senden“).
6. **Exportieren** – kopieren, teilen oder als Markdown-Datei speichern.

Alles (Audio, Texte, Schlüssel) wird nur **lokal im Browser** gespeichert (IndexedDB/localStorage).

## Einrichtung

In den Einstellungen (Zahnrad):

- **OpenAI-API-Schlüssel** für die Transkription – https://platform.openai.com/api-keys
- **Anthropic-API-Schlüssel** für Nachbessern und Zusammenfassung – https://console.anthropic.com/settings/keys
- **Fachbegriffe / Namen** (unter „Erweitert“) – verbessert die Erkennung spürbar, z. B. Firmennamen, Produkte, Personen.

### To-dos in die To-do-App

| Einstellung | Was passiert |
|---|---|
| **Apple Erinnerungen (Kurzbefehl)** | Öffnet den Kurzbefehl „Plaude To-do“ mit den Aufgaben (eine pro Zeile). |
| **Things** | Legt die Aufgaben direkt in Things an. |
| **Todoist** | Legt eine Aufgabe in Todoist an (mehrere über das Teilen-Menü). |
| **Teilen-Menü** | Öffnet das System-Teilen-Menü – damit geht jede andere App. |

**Kurzbefehl für Apple Erinnerungen einmalig anlegen** (Kurzbefehle-App → „+“):

1. Aktion **„Text teilen“** → Eingabe: *Kurzbefehleingabe*, teilen nach *Neue Zeilen*
2. Aktion **„Wiederholen mit jedem“** (für die geteilten Texte)
3. Darin Aktion **„Erinnerung hinzufügen“** → Text: *Wiederholungsobjekt* (Liste nach Wunsch wählen)
4. Kurzbefehl **„Plaude To-do“** nennen (oder den Namen in den Einstellungen anpassen).

## Aufs Handy bringen

Mikrofon-Zugriff gibt es im Browser nur über **HTTPS**. Am einfachsten über GitHub Pages:
*Settings → Pages → Deploy from a branch → `main` / `(root)`*. Danach die Seite in Safari öffnen,
dann **Teilen → Zum Home-Bildschirm** – so startet sie wie eine App.

Hinweis iPhone: Während der Aufnahme den Bildschirm anlassen (die App versucht das automatisch).
Wird das Handy gesperrt, stoppt Safari das Mikrofon. Alles bis dahin Aufgenommene bleibt aber gespeichert.

Lokal testen: `python3 -m http.server 8000` → http://localhost:8000

## Dateien

```
index.html               Oberfläche
app.js                   Aufnahme, Speicher, Transkription, Claude, To-do-Versand
app.css                  Gestaltung (hell/dunkel)
vendor/anthropic-sdk.js  Offizielles Anthropic-JS-SDK (@anthropic-ai/sdk 0.131.0), lokal gebündelt
manifest.webmanifest, icon*.png, icon.svg   Home-Bildschirm-App
```

## Kosten (ungefähr)

- Transkription `gpt-4o-transcribe`: ca. 0,6 US-Cent pro Minute Audio.
- Claude (Nachbessern + Zusammenfassung) mit `claude-opus-5-5`: je nach Länge wenige Cent pro Ordner.
  In den Einstellungen kann man ein günstigeres Modell eintragen (z. B. `claude-sonnet-5-5`)
  oder das Nachbessern abschalten.
