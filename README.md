<div align="center">
  <img src="public/favicon.svg" alt="Meta Display Apps" width="76">
  <h1>WebUntis Glasses</h1>
  <p><strong>Dein Stundenplan auf Meta Display Glasses.</strong></p>
  <p>Einmal verbinden. Angemeldet bleiben. Mit Sorgfalt gebaut von Meta Display Apps.</p>
  <p><a href="https://webuntis-glasses.henning-orbit-calendar.workers.dev/">Web-App öffnen</a> · <a href="https://webuntis-glasses.henning-orbit-calendar.workers.dev/glasses.html">Brillenansicht</a> · <a href="https://github.com/Henning1908/orbit-calendar-glasses">Orbit Calendar</a></p>
</div>

---

## Was die App macht

WebUntis Glasses zeigt den nächsten Unterricht und den Tagesplan auf Meta Display Glasses. Richte die Verbindung einmal im Browser ein. Die verschlüsselt gespeicherte WebUntis-Sitzung bleibt über Neustarts hinweg erhalten und wird automatisch erneuert, wenn WebUntis sie beendet.

### In drei Schritten starten

1. Öffne die [Brillenansicht](https://webuntis-glasses.henning-orbit-calendar.workers.dev/glasses.html). Sie zeigt einen Verbindungscode.
2. Öffne die [Web-App](https://webuntis-glasses.henning-orbit-calendar.workers.dev/) auf einem Handy oder Computer. Gib den Code und deine WebUntis-Anmeldung ein.
3. Der Stundenplan erscheint auf der Brille und aktualisiert sich automatisch.

Standardmäßig ist die Schule `ggb` mit `https://ggb.webuntis.com` eingetragen. Server und Schulkennung lassen sich vor dem Verbinden ändern. Verwende dein normales WebUntis-Passwort. Der WebUntis-Mobile-QR-Schlüssel ist kein Passwort.

## Datenschutz und Speicherung

- Zugangsdaten und die wiederverwendbare WebUntis-Sitzung liegen gemeinsam AES-GCM-verschlüsselt in Cloudflare D1.
- Der Einrichtungsbrowser erhält ein zufälliges, dauerhaftes `HttpOnly`-Cookie. Die WebUntis-Sitzung wird bei jedem Abruf wiederverwendet und erst nach Ablauf automatisch erneuert.
- Der Verschlüsselungsschlüssel wird als Cloudflare Worker Secret verwaltet und nicht in Git gespeichert.
- Die Brille speichert nur eine zufällige Gerätekennung. Dein Passwort wird nicht an die Brille übertragen.
- Beim Trennen der Verbindung werden das verschlüsselte Profil und offene Kopplungscodes aus D1 gelöscht.
- WebUntis-Anfragen werden vom Worker gesendet. Die App zeigt nur den eigenen Stundenplan an.

Für einen öffentlichen Betrieb braucht das Projekt eine passende Datenschutzerklärung mit Verantwortlichkeit, Kontakt, Speicherfristen und den beteiligten Dienstleistern. Die aktuelle Version ist für persönliche Nutzung gedacht.

## Lokale Entwicklung

Voraussetzung: Node.js 20 oder neuer.

```sh
npm install
npx wrangler login
npm run dev
```

Wrangler nutzt standardmäßig eine lokale D1-Datenbank. Wende das Schema lokal mit `npx wrangler d1 migrations apply webuntis-glasses --local` an. Kopiere `.dev.vars.example` nach `.dev.vars` und ersetze dort den Beispielwert:

```text
WEBUNTIS_ENCRYPTION_KEY=ein-langer-zufälliger-geheimer-wert
```

`.dev.vars` wird nicht versioniert.

## Cloudflare bereitstellen

1. Erstelle in Cloudflare eine D1-Datenbank namens `webuntis-glasses`.
2. Trage ihre ID in `wrangler.jsonc` ein.
3. Installiere Abhängigkeiten und richte Wrangler ein:

   ```sh
   npm install
   npx wrangler login
   ```

4. Wende die Migration an und setze den Verschlüsselungsschlüssel:

   ```sh
   npx wrangler d1 migrations apply webuntis-glasses --remote
   npx wrangler secret put WEBUNTIS_ENCRYPTION_KEY
   ```

5. Stelle die App bereit:

   ```sh
   npm run deploy
   ```

Cloudflare zeigt danach die `workers.dev`-Adresse an. Aktualisiere bei einer neuen eigenen Adresse die kanonischen URLs in `public/index.html` und `public/glasses.html` sowie die Links in dieser README.

## Architektur

```text
Meta Display Glasses ── Gerätekennung ─┐
                                      ├── Cloudflare Worker ── WebUntis
Handy / Computer ── Einmal-Code ──────┘          │
                                         verschlüsseltes Profil
                                            in Cloudflare D1
```

`src/worker.js` verarbeitet Kopplung, WebUntis JSON-RPC und D1-Speicherung. Die Webseiten liegen in `public/` und werden über Cloudflare Workers Static Assets ausgeliefert. Die Sitzungs-ID wird beim Stundenplanabruf wiederverwendet; schlägt sie fehl, meldet der Worker das gespeicherte Profil erneut an und legt die neue Sitzungs-ID sicher ab.

## Projekte aus einer Werkstatt

Meta Display Apps ist die gemeinsame Klammer für Apps auf Meta Smart Glasses. [Orbit Calendar](https://github.com/Henning1908/orbit-calendar-glasses) und WebUntis Glasses teilen dieselbe dunkle, klare Gestaltung und denselben Fokus auf kurze, gut lesbare Informationen im Display.

## Lizenz

MIT. Siehe [LICENSE](LICENSE).
