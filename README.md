# Plaude – Aufnahmen, Transkript, Zusammenfassung & To-dos

Web-App fürs Handy: Gespräche aufnehmen, sauber transkribieren lassen und pro **Ordner**
(z. B. „Einkauf Baumarkt 14:30“) eine gemeinsame Zusammenfassung mit Stichpunkten und To-dos bekommen.
Jedes To-do landet per Knopfdruck direkt im **Aufgabenplaner** (Repo `To-do`, gleiche Supabase-Datenbank).

## So funktioniert's

1. **Ordner anlegen** (oder „Sofort aufnehmen“ – dann heißt der Ordner nach Datum und Uhrzeit).
2. **Aufnehmen** – beliebig viele Aufnahmen pro Ordner. Lange Aufnahmen werden automatisch in 4-Minuten-Stücke geteilt.
3. **Transkription** mit OpenAI `gpt-4o-transcribe`, danach bessert Claude jedes Stück nach:
   Erkennungsfehler, Zeichensetzung, Absätze, Füllwörter. Der Originaltext bleibt unter „Original-Erkennung“ abrufbar.
4. **Zusammenfassung** über *alle* Aufnahmen des Ordners: Kurzfassung, Stichpunkte nach Themen,
   To-dos (mit „wer“ und „bis wann“), Entscheidungen, offene Fragen.
5. **To-dos**: abhaken oder mit dem Pfeil (einzeln) bzw. „Alle offenen senden“ in den Aufgabenplaner schicken.
   Die **KI ordnet jedes To-do selbst einer Spalte zu** (☀️ Heute / 🔁 Prozess / 🔒 Privat). Ein Tipp auf die Spalte
   ändert sie von Hand. In den Einstellungen lässt sich auch eine feste Spalte für alles einstellen. Alternativ: Apple Erinnerungen
   über einen Kurzbefehl, Things, Todoist oder das Teilen-Menü.
6. **Export** – kopieren, teilen oder als Markdown-Datei speichern.

## Sicherheit

- **Passwort-Login**: Ohne `APP_PASSWORD` kommt niemand an die Server-Funktionen (Transkription, Claude, Aufgabenplaner).
  Die Anmeldung ist ein signiertes, `HttpOnly`-/`Secure`-/`SameSite=Strict`-Cookie (30 Tage). Falsche Passwörter werden ausgebremst.
- **Keine Schlüssel auf dem Handy oder im Code**: OpenAI-, Anthropic- und Supabase-Schlüssel liegen nur in den
  Umgebungsvariablen bei Vercel.
- **Aufnahmen bleiben auf deinem Gerät** (IndexedDB im Browser). Zum Transkribieren geht ein Audio-Stück einmal durch
  die Vercel-Funktion an OpenAI und wird dabei nirgends gespeichert. In der Datenbank landen nur die To-dos, die du abschickst.
- Strenge Sicherheits-Header (Content-Security-Policy, kein Einbetten in fremde Seiten, `noindex`).

## Einrichtung auf Vercel

1. Auf [vercel.com](https://vercel.com) mit GitHub anmelden → **Add New… → Project** → Repo `Plaude-auf-Temu` importieren
   (Framework: *Other*, keine Build-Einstellungen nötig).
2. Unter **Settings → Environment Variables** eintragen:

   | Name | Wert |
   |---|---|
   | `APP_PASSWORD` | Dein Passwort für die App – lang und eindeutig wählen |
   | `OPENAI_API_KEY` | https://platform.openai.com/api-keys |
   | `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys |
   | `SUPABASE_URL` | Dieselbe wie im Aufgabenplaner (`https://xxxx.supabase.co`) |
   | `SUPABASE_ANON_KEY` | Derselbe anon key wie im Aufgabenplaner |

   Optional: `CLAUDE_MODEL` (Standard `claude-opus-5-5`), `OPENAI_TRANSCRIBE_MODEL` (Standard `gpt-4o-transcribe`),
   `SESSION_SECRET` (beliebige lange Zeichenfolge; ändern meldet alle Geräte ab).
3. **Deploy** (bzw. nach dem Eintragen der Variablen einmal *Redeploy*).
4. Die Vercel-Adresse in Safari öffnen → anmelden → **Teilen → Zum Home-Bildschirm**.

### Aufnehmen, während man andere Apps nutzt oder das Handy sperrt

iOS erlaubt Web-Apps **kein Mikrofon im Hintergrund**. Plaude geht damit so um:

- Beim Verlassen der App wird alles bis dahin Aufgenommene sofort gespeichert.
- Beim Zurückkommen läuft die Aufnahme **automatisch in derselben Aufnahme weiter** (angezeigt als „1× unterbrochen“).
  Lässt iOS das Mikrofon nicht von selbst wieder an, erscheint der Knopf **„Mikrofon wieder an – weiter aufnehmen“**.
- Hat iOS die App im Hintergrund ganz beendet, steht beim nächsten Öffnen **„Aufnahme wurde unterbrochen“** mit
  **„Weiter aufnehmen“** (gleiche Aufnahme) oder **„Beenden & auswerten“**.
- Was in der Zwischenzeit gesagt wurde, ist allerdings nicht drauf.
- **Für durchgehende Aufnahmen mit WhatsApp/gesperrtem Handy:** mit der Apple-App **Sprachmemos** aufnehmen
  (läuft im Hintergrund weiter) → Memo teilen → **„In Dateien sichern“** → in Plaude **„Audiodatei hinzufügen“**.
  Auch lange Memos gehen: Plaude teilt große Dateien selbst in kleine Stücke.

## iPhone-App (nimmt im Hintergrund weiter auf)

Die Web-App darf auf dem iPhone im Hintergrund nicht aufnehmen. Dafür gibt es eine kleine **echte App** (`ios/`):
Sie zeigt dieselbe Plaude-Seite, das Aufnehmen macht aber das iPhone selbst. Die Aufnahme läuft also weiter,
auch mit WhatsApp im Vordergrund, bei gesperrtem Handy, und nach Anrufen.

GitHub baut die App bei jeder Änderung unter `ios/` automatisch. Die neueste Datei liegt immer hier:
**https://github.com/michapeterson-del/Plaude-auf-Temu/releases/latest/download/Plaude.ipa**

### Einmalig einrichten (Windows-PC, normale Apple-ID, kostenlos)

1. Auf dem PC **iTunes** und **iCloud** von apple.com installieren (nicht die Microsoft-Store-Versionen).
2. **SideStore** einrichten: Anleitung auf https://sidestore.io (*Get Started*). Dabei meldest du dich in
   SideStore mit deiner Apple-ID an. Das Passwort geht nur an Apple.
3. Auf dem iPhone: Einstellungen → Datenschutz & Sicherheit → **Entwicklermodus** einschalten (Neustart).
4. Den Link oben in Safari öffnen → `Plaude.ipa` laden → in **SideStore** auf „+“ tippen und die Datei aus *Downloads* wählen.
5. Einstellungen → Allgemein → VPN & Geräteverwaltung → deiner Apple-ID **vertrauen**.
6. Plaude öffnen → Adresse deiner Vercel-Seite bestätigen → anmelden → Mikrofon erlauben.

### Alle 7 Tage erneuern

Mit einer normalen Apple-ID läuft die App 7 Tage. In **SideStore** auf **„Refresh All“** tippen (geht ohne PC).
Tipp: In der Kurzbefehle-App eine Automation „Täglich“ → SideStore *Refresh All* anlegen, dann passiert es von selbst.
Aufnahmen und Daten bleiben beim Erneuern erhalten.

### Update installieren

Neue Version wie in Schritt 4 laden und in SideStore installieren. Daten bleiben erhalten.

## Dateien

```
index.html, app.js, app.css   Oberfläche (Aufnahme, Speicher, Ansichten)
api/session.js                Anmelden / Abmelden / Status
api/transcribe.js             Audio-Stück → OpenAI → Text
api/claude.js                 Nachbessern + Zusammenfassung (Claude, Anweisungen liegen hier)
api/todo.js                   To-dos in den Aufgabenplaner (Supabase "tasks")
lib/server.js                 Login-Cookie, Hilfsfunktionen
vercel.json                   Laufzeit + Sicherheits-Header
ios/                          iPhone-App (SwiftUI + nativer Rekorder), gebaut von .github/workflows/ios.yml
```

## Kosten (ungefähr)

- Transkription `gpt-4o-transcribe`: ca. 0,6 US-Cent pro Minute Audio.
- Claude (`claude-opus-5-5`): je nach Länge wenige Cent pro Ordner. Günstiger: `CLAUDE_MODEL=claude-sonnet-5-5`
  setzen oder das Nachbessern in den Einstellungen abschalten.
- Vercel Hobby (kostenlos) reicht für den persönlichen Gebrauch.
