-- Training slot and pitch allocation schema (MVP)
-- Run in Supabase SQL Editor

create table if not exists public.pitches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  surface text not null check (surface in ('KUNSTRASEN','RASEN')),
  capacity_quarters int not null default 4 check (capacity_quarters = 4),
  sort_order int not null default 0
);

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

-- Seed: slots (Di=2, Do=4)
insert into public.training_slots (weekday, label, start_time, end_time, sort_order)
values
  (2, '16:30–18:00', '16:30', '18:00', 1),
  (2, '18:00–19:30', '18:00', '19:30', 2),
  (2, '19:30–21:00', '19:30', '21:00', 3),
  (4, '16:30–18:00', '16:30', '18:00', 1),
  (4, '18:00–19:30', '18:00', '19:30', 2),
  (4, '19:30–21:00', '19:30', '21:00', 3)
on conflict do nothing;
