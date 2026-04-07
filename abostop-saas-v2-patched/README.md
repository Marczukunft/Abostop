# AboStop SaaS v2

Diese Version ist eine echte kleine Web-App mit:
- Benutzerkonto / Registrierung / Login
- SQLite-Datenbank
- JWT-Authentifizierung
- Abo-Verwaltung per API
- Kündigungsvorlagen
- vorbereiteten E-Mail-Remindern per SMTP
- täglichem Cron-Lauf für Reminder

## Ordnerstruktur
- `server.js` – Backend + API + Cron
- `public/` – Frontend
- `data/` – SQLite-Datenbank
- `.env.example` – Umgebungsvariablen
- `scripts/init-db.js` – DB-Initialisierung

## Installation
1. Node.js 18 oder neuer installieren.
2. Im Projektordner ausführen:

```bash
npm install
cp .env.example .env
npm run init-db
npm start
```

Dann im Browser öffnen:
- `http://localhost:3000`

## Wichtige Umgebungsvariablen
- `JWT_SECRET` – unbedingt ändern
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` – für echte Reminder-Mails
- `APP_BASE_URL` – URL deiner Live-App
- `CRON_SCHEDULE` – Standard: täglich 09:00 Uhr

## Was schon funktioniert
- Registrierung und Login
- persönlicher Abo-Bereich pro Nutzer
- Abos erstellen und löschen
- Statistiken
- Kündigungsvorlage erzeugen
- Reminder-Lauf manuell starten (`Reminder-Lauf testen`)
- täglicher Reminder-Job im Server

## Was du als Nächstes sinnvoll bauen kannst
- Passwort-Reset per E-Mail
- Abo bearbeiten
- Stripe / Lemon Squeezy für Bezahlung
- echtes Multi-Tenant-Hosting
- Admin-Dashboard
- DSGVO-/Impressum-/Datenschutz-Seiten
- Rate Limiting + E-Mail-Verifikation

## Deployment-Ideen
### Einfacher VPS
- Node-App mit PM2 starten
- Nginx davor
- SQLite für den Anfang ok

### Später professioneller
- PostgreSQL statt SQLite
- Mailgun / Brevo / Resend für E-Mails
- Render / Railway / Fly.io / Hetzner Cloud

## Ehrlicher Hinweis
Das ist eine gute **SaaS-Basis**, aber noch kein komplett abgesichertes Produktionssystem.
Für echten Live-Betrieb solltest du mindestens noch ergänzen:
- Rate Limiting
- Passwort-Reset
- E-Mail-Verifikation
- Backups
- TLS/HTTPS
- Rechtstexte


## Patch-Hinweis
Diese Version enthält einen zusätzlichen Button **Testmail senden** und detailliertere Antworten für den Reminder-Lauf.
