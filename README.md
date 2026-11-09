# WebUntis Glasses

> Ein glanceable Stundenplan für Meta Display Glasses – gekoppelt über einen
> einmaligen 6-stelligen Code.

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-5fa04e)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Was ist das?

WebUntis Glasses verbindet eine Web-App auf der Brille mit einer PC-Ansicht.
Die Brille zeigt beim Öffnen einen 6-stelligen Code. Auf dem PC wird dieser Code
zusammen mit den WebUntis-Zugangsdaten bestätigt. Danach zeigt die Brillenansicht
die nächsten Stunden mit Fach, Uhrzeit und Raum.

Der Prototyp ist auf die WebUntis-Schule `ggb` voreingestellt, kann aber über die
Login-Anfrage auch mit einer anderen WebUntis-Instanz verwendet werden.

> **Hinweis:** Der aktuelle Prototyp verwendet den normalen WebUntis-Benutzernamen
> und das normale WebUntis-Passwort. Der WebUntis-Mobile-QR-Schlüssel ist kein
> Passwort und wird von dieser Version noch nicht als Login verwendet.

## Architektur

```text
Meta Display Glasses  ── HTTPS ──┐
                                 ├── Node.js server ── WebUntis JSON-RPC
PC browser          ── HTTPS ────┘
```

- `public/glasses.html`: reduzierte Brillenansicht und Code-Erzeugung
- `public/index.html`: PC-Kopplung, Login und Stundenplan
- `server.js`: Pairing, verschlüsselte Speicherung und WebUntis-API
- `render.yaml`: Ein-Klick-Konfiguration für Render

## Schnellstart lokal

Voraussetzung: Node.js 20 oder neuer.

```powershell
Set-Location 'D:\Programmieren\WebUntis'
Copy-Item .env.example .env
$env:WEBUNTIS_ENCRYPTION_KEY = 'ein-langer-zufälliger-geheimer-schlüssel'
npm start
```

Ohne lokales Zertifikat läuft der Server unter `http://localhost:3000`.
Für die Brille wird HTTPS benötigt. Erzeuge dafür einmal ein lokales Zertifikat
(OpenSSL, Git for Windows enthält es):

```powershell
New-Item -ItemType Directory -Force data | Out-Null
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 365 `
  -keyout data\localhost-key.pem -out data\localhost-cert.pem `
  -subj "/CN=WebUntis Glasses" `
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:192.168.10.17"
```

Danach startet der Server automatisch per HTTPS. Selbstsignierte Zertifikate
werden von einigen Brillen nicht akzeptiert; für echte Nutzung ist Hosting mit
öffentlichem HTTPS vorzuziehen.

## Deployment auf Render

1. Repository auf GitHub pushen.
2. In Render **New → Web Service** auswählen und das Repository verbinden.
3. `Build Command`: `npm install`
4. `Start Command`: `npm start`
5. Environment Variable setzen:
   - `WEBUNTIS_ENCRYPTION_KEY`: langer zufälliger Wert
6. Deploy starten.

Render beendet TLS vor der Node-App und stellt automatisch eine öffentliche
`https://...onrender.com`-Adresse bereit. In diesem Fall werden keine lokalen
Zertifikatsdateien benötigt. Öffne anschließend:

```text
https://DEINE-APP.onrender.com/glasses.html
```

## Sicherheit

- Zugangsdaten werden nicht ins Frontend übertragen oder ins Repository geschrieben.
- Die gespeicherten Zugangsdaten werden mit AES-256-GCM verschlüsselt.
- `WEBUNTIS_ENCRYPTION_KEY` muss als geheime Umgebungsvariable gesetzt werden.
- `data/`, `.env` und lokale Schlüssel sind absichtlich gitignored.
- Dies ist ein persönliches Hobbyprojekt. Vor öffentlichem Betrieb sollten
  Rate-Limiting, Benutzerkonten, Logout/Token-Widerruf und eine Datenbank ergänzt
  werden.

## Prüfen

```powershell
npm run check
```

## Lizenz

MIT – siehe [LICENSE](LICENSE).
