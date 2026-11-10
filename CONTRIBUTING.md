# Contributing

Danke für dein Interesse an WebUntis Glasses.

## Lokal entwickeln

```sh
npm install
Copy-Item .dev.vars.example .dev.vars
npx wrangler d1 migrations apply webuntis-glasses --local
npm run dev
```

Setze einen eigenen zufälligen Wert für `WEBUNTIS_ENCRYPTION_KEY` in `.dev.vars`.

## Änderungen prüfen

```sh
npm run check
```

Keine Zugangsdaten, Sitzungskennungen, Secrets oder Dateien aus `.wrangler/`
committen. Beschreibe bei Beiträgen kurz die Motivation und die geänderten
Bereiche.
