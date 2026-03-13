-- Training slot and pitch allocation schema (MVP)
-- Run in Supabase SQL Editor

create table if not exists public.pitches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  surface text not null check (surface in ('KUNSTRASEN','RASEN')),
  capacity_quarters int not null default 4 check (capacity_quarters = 4),
  sort_order int not null default 0
);

-- Damit Seeds mehrfach ausführbar sind (und um Dubletten zu vermeiden)
create unique index if not exists uniq_pitches_name on public.pitches (name);

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort_order int not null default 0
);

create table if not exists public.training_slots (
  id uuid primary key default gen_random_uuid(),
  weekday int not null check (weekday between 1 and 7), -- 1=Mon ... 7=Sun
  label text not null,
  start_time time not null,
  end_time time not null,
  sort_order int not null default 0,
  check (end_time > start_time)
);

-- eindeutige Slots pro Wochentag+Label
create unique index if not exists uniq_training_slots_weekday_label
  on public.training_slots (weekday, label);

create table if not exists public.allocations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  pitch_id uuid not null references public.pitches(id) on delete cascade,
  weekday int not null check (weekday between 1 and 7),
  start_time time not null,
  end_time time not null,
  quarters int not null check (quarters in (1,2,3,4)),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_time > start_time)
);

-- ------------------------------------------------------------
-- Serienbuchungen (mit echten Kalenderterminen)
--
-- Ziel:
-- - Eine "Serie" (z.B. jeden 2. Mittwoch bis Ende Juni) speichern
-- - Konkrete Termine als einzelne Zeilen erzeugen (damit einzelne Termine
--   aus einer Serie storniert werden können)
-- ------------------------------------------------------------

create table if not exists public.booking_series (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete restrict,
  pitch_id uuid not null references public.pitches(id) on delete restrict,
  slot_id uuid not null references public.training_slots(id) on delete restrict,
  weekday int not null check (weekday between 1 and 7), -- 1=Mon..7=Sun
  start_date date not null,
  until_date date not null,
  interval_weeks int not null default 1 check (interval_weeks between 1 and 4),
  quarters int not null check (quarters in (1,2,3,4)),
  note text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','CANCELLED')),
  created_at timestamptz not null default now()
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  series_id uuid references public.booking_series(id) on delete set null,
  team_id uuid not null references public.teams(id) on delete restrict,
  pitch_id uuid not null references public.pitches(id) on delete restrict,
  slot_id uuid not null references public.training_slots(id) on delete restrict,
  booking_date date not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  quarters int not null check (quarters in (1,2,3,4)),
  note text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','CANCELLED')),
  created_at timestamptz not null default now(),
  check (end_at > start_at)
);

-- Performance: typische Abfragen sind "alle Buchungen für Datum+Slot+Platz".
create index if not exists idx_bookings_lookup
  on public.bookings (booking_date, slot_id, pitch_id);
create index if not exists idx_bookings_series
  on public.bookings (series_id);
create index if not exists idx_booking_series_status
  on public.booking_series (status);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_allocations_updated_at on public.allocations;
create trigger trg_allocations_updated_at
before update on public.allocations
for each row execute procedure public.set_updated_at();

-- Seed: 6 pitches
insert into public.pitches (name, surface, sort_order)
values
  ('KR1','KUNSTRASEN',1),
  ('KR2','KUNSTRASEN',2),
  ('KR3','KUNSTRASEN',3),
  ('R1','RASEN',4),
  ('R2','RASEN',5),
  ('R3','RASEN',6)
on conflict do nothing;

-- Seed: slots (Mi=3, Fr=5)
insert into public.training_slots (weekday, label, start_time, end_time, sort_order)
values
  (3, '16:30–18:00', '16:30', '18:00', 1),
  (3, '18:00–19:30', '18:00', '19:30', 2),
  (3, '19:30–21:00', '19:30', '21:00', 3),
  (5, '16:30–18:00', '16:30', '18:00', 1),
  (5, '18:00–19:30', '18:00', '19:30', 2),
  (5, '19:30–21:00', '19:30', '21:00', 3)
on conflict do nothing;
