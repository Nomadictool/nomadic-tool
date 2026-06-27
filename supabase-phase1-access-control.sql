-- ══════════════════════════════════════════════════════════════════
-- PHASE 1: PIN-based access control + Row Level Security
-- Run this ENTIRE script once in the Supabase SQL Editor
-- (Project > SQL Editor > New Query > paste all of this > Run)
-- ══════════════════════════════════════════════════════════════════

-- ── New tables ──────────────────────────────────────────────────
create table employees (
  id              uuid primary key,        -- == auth.users.id, set explicitly when created
  name            text not null,
  pin             text not null,
  active          bool not null default true,
  role            text not null default 'staff' check (role in ('admin','staff')),
  synthetic_email text not null unique,
  created_at      timestamptz not null default now()
);
create unique index employees_pin_active_uniq on employees (pin) where active = true;

create table fire_assignments (
  employee_id uuid not null references employees(id) on delete cascade,
  incident_id text not null references incidents(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (employee_id, incident_id)
);

-- ── Admin-check helper, reused by every policy below ───────────
create function is_admin() returns boolean
  language sql security definer stable as
  $$ select exists (select 1 from employees where id = auth.uid() and role = 'admin' and active = true) $$;

-- ── employees ───────────────────────────────────────────────────
alter table employees enable row level security;

create policy employees_select_self on employees
  for select using (id = auth.uid());

create policy employees_admin_all on employees
  for all using (is_admin());

-- ── fire_assignments ────────────────────────────────────────────
alter table fire_assignments enable row level security;

create policy fire_assignments_select_own on fire_assignments
  for select using (employee_id = auth.uid() or is_admin());

create policy fire_assignments_admin_write on fire_assignments
  for all using (is_admin());

-- ── incidents (this is the actual security fix) ────────────────
alter table incidents enable row level security;

create policy incidents_select_assigned on incidents
  for select using (
    is_admin()
    or exists (select 1 from fire_assignments fa where fa.incident_id = incidents.id and fa.employee_id = auth.uid())
  );

create policy incidents_update_assigned on incidents
  for update using (
    is_admin()
    or exists (select 1 from fire_assignments fa where fa.incident_id = incidents.id and fa.employee_id = auth.uid())
  );

create policy incidents_insert_admin on incidents
  for insert with check (is_admin());

create policy incidents_delete_admin on incidents
  for delete using (is_admin());

-- ── app_config (rates, error_log, etc.) ─────────────────────────
alter table app_config enable row level security;

create policy app_config_select_authenticated on app_config
  for select using (auth.role() = 'authenticated');

create policy app_config_write_rates_admin on app_config
  for all using (is_admin());

-- ══════════════════════════════════════════════════════════════════
-- After running this, you MUST also:
-- 1. In Supabase Dashboard > Database > Replication, confirm Realtime
--    is enabled with RLS enforcement for the `incidents` table (it
--    should already pick up the new policies automatically, but
--    verify rather than assume).
-- 2. Set the SUPABASE_SERVICE_ROLE_KEY environment variable in Netlify
--    (Site settings > Environment variables) using the "service_role"
--    key from Supabase Dashboard > Project Settings > API. Never put
--    this key anywhere in the HTML/client code.
-- 3. Create your own admin account: the admin-employees function allows
--    creating exactly one employee with no admin token, ONLY while the
--    `employees` table is empty (a one-time bootstrap). Use this to
--    create yourself as the first admin, then every employee after
--    that requires an existing admin to create them. See the app's
--    new login/setup screen for how to trigger this the first time.
-- ══════════════════════════════════════════════════════════════════
