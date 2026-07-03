-- ══════════════════════════════════════════════════════════════════
-- Fleet Management: add new columns to units table
-- Run ONCE in Supabase SQL Editor (table already exists from fleet v1)
-- ══════════════════════════════════════════════════════════════════

alter table units add column if not exists dispatch_location_fs  text;
alter table units add column if not exists dispatch_location_cf  text;
alter table units add column if not exists reg_expiration        date;
alter table units add column if not exists reg_no_expiration     boolean not null default false;
