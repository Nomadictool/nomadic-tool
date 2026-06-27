-- ══════════════════════════════════════════════════════════════════
-- PHASE 2: Expense report submit/approve workflow
-- Run this ENTIRE script once in the Supabase SQL Editor, AFTER
-- Phase 1 (supabase-phase1-access-control.sql) has already been run
-- (this depends on the employees table and is_admin() function from
-- Phase 1).
-- ══════════════════════════════════════════════════════════════════

create table expense_reports (
  id               uuid primary key default gen_random_uuid(),
  employee_id      uuid not null references employees(id),
  incident_id      text references incidents(id),
  pay_period_start date not null,
  pay_period_end   date not null,
  status           text not null default 'draft' check (status in ('draft','submitted','approved','rejected')),
  submitted_at     timestamptz,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table expense_line_items (
  id                 uuid primary key default gen_random_uuid(),
  expense_report_id  uuid not null references expense_reports(id) on delete cascade,
  date               date not null,
  company_name       text,
  invoice_number     text,
  description        text,
  charge_account      text,
  amount             numeric(10,2) not null default 0,
  category           text not null check (category in ('lodging','mileage','supplies','per_diem_difference','other')),
  receipt_status     text not null default 'none' check (receipt_status in ('none','pending','attached')),
  start_address      text,
  finish_address     text,
  miles              numeric(8,2),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ── RLS ─────────────────────────────────────────────────────────
alter table expense_reports enable row level security;
alter table expense_line_items enable row level security;

create policy expense_reports_select on expense_reports
  for select using (employee_id = auth.uid() or is_admin());

create policy expense_reports_insert on expense_reports
  for insert with check (employee_id = auth.uid());

create policy expense_reports_update on expense_reports
  for update using (
    (employee_id = auth.uid() and status = 'draft')
    or is_admin()
  );

create policy expense_reports_delete on expense_reports
  for delete using (employee_id = auth.uid() and status = 'draft');

create policy expense_line_items_select on expense_line_items
  for select using (
    exists (select 1 from expense_reports r where r.id = expense_line_items.expense_report_id
            and (r.employee_id = auth.uid() or is_admin()))
  );

create policy expense_line_items_insert on expense_line_items
  for insert with check (
    exists (select 1 from expense_reports r where r.id = expense_line_items.expense_report_id
            and r.employee_id = auth.uid() and r.status = 'draft')
  );

create policy expense_line_items_update on expense_line_items
  for update using (
    exists (select 1 from expense_reports r where r.id = expense_line_items.expense_report_id
            and (r.employee_id = auth.uid() or is_admin()))
  );

create policy expense_line_items_delete on expense_line_items
  for delete using (
    exists (select 1 from expense_reports r where r.id = expense_line_items.expense_report_id
            and r.employee_id = auth.uid() and r.status = 'draft')
  );

-- Once a report is submitted, an employee can still flip receipt_status
-- (attach a receipt that wasn't ready yet) but cannot edit amounts/dates/
-- etc. Admin can edit anything during review.
create function enforce_line_item_lock() returns trigger as $$
begin
  if (select status from expense_reports where id = OLD.expense_report_id) != 'draft'
     and not is_admin() then
    if NEW.amount         is distinct from OLD.amount
    or NEW.date           is distinct from OLD.date
    or NEW.company_name   is distinct from OLD.company_name
    or NEW.invoice_number  is distinct from OLD.invoice_number
    or NEW.description     is distinct from OLD.description
    or NEW.charge_account   is distinct from OLD.charge_account
    or NEW.category         is distinct from OLD.category
    or NEW.start_address    is distinct from OLD.start_address
    or NEW.finish_address   is distinct from OLD.finish_address
    or NEW.miles            is distinct from OLD.miles
    then
      raise exception 'Cannot modify a submitted line item except its receipt status';
    end if;
  end if;
  return NEW;
end;
$$ language plpgsql security definer;

create trigger trg_enforce_line_item_lock
  before update on expense_line_items
  for each row execute function enforce_line_item_lock();
