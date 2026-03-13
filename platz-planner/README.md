# Platz‑Planner (Training Allocator)

Minimaler Next.js (App Router) Planer, um Mannschaften auf Felder zu verteilen:
- 6 Felder (3 Kunstrasen + 3 Rasen)
- 3 Slots pro Trainingstag (Di/Do)
- Bedarf pro Team in Vierteln (1/4..4/4)
- Konfliktprüfung pro Feld+Slot+Datum (Summe <= 4)

## Neu: Serienbuchungen (mit echtem Kalender)
- Einzeltermin (nur ein Datum)
- Serie: jede Woche / jeden 2. Termin / … bis Enddatum
- Einzelne Termine aus einer Serie können storniert werden
- Kollisionshinweis mit "Serienbuchung" vs. "Einzelbuchung"

## Setup
1. `npm install`
2. Supabase:
   - Projekt erstellen
   - SQL aus `supabase/schema.sql` im SQL Editor ausführen
   - Teams in der Tabelle `teams` anlegen
3. `.env.local`:
   - `.env.local.example` kopieren -> `.env.local`
   - `NEXT_PUBLIC_SUPABASE_URL` und `NEXT_PUBLIC_SUPABASE_ANON_KEY` aus Supabase (Project Settings -> API) eintragen
4. `npm run dev`

## Routes
- `/` Startseite
- `/plan` Plan‑Ansicht (Tabelle + Add/Delete)

## Hinweis
RLS ist fürs MVP nicht nötig (kannst du später aktivieren).
