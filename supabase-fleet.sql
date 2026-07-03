-- ══════════════════════════════════════════════════════════════════
-- Fleet Management: units table
-- Run ONCE in Supabase SQL Editor after Phase 1 has already been run
-- (depends on is_admin() function from Phase 1).
-- ══════════════════════════════════════════════════════════════════

create table units (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,
  type             text,
  year             text,
  make             text,
  model            text,
  vin              text,
  license_plate    text,
  registered_state text,
  has_title        boolean not null default true,
  length_ft        numeric(5,1),
  width_ft         numeric(5,1),
  day_rate         numeric(10,2),
  storage_location text,
  manual_status    text not null default 'available'
                   check (manual_status in ('available','maintenance','storage','retired')),
  notes            text,
  updated_at       timestamptz not null default now()
);

-- All authenticated employees can read fleet data (staff can see which unit
-- they're on). Only admins can create/edit/delete units.
alter table units enable row level security;

create policy units_select_auth on units
  for select using (auth.role() = 'authenticated');

create policy units_write_admin on units
  for all using (is_admin());
