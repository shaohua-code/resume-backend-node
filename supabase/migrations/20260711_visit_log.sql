-- ============================================================
-- 访客访问记录表（保留 30 天）
-- 幂等脚本，重复执行不会报错
-- ============================================================

create table if not exists public.visit_log (
  id bigserial primary key,
  user_email text default '',
  ip_address text default '',
  province text default '',
  city text default '',
  browser text default '',
  os text default '',
  device_type text default '',
  device_brand text default '',
  visit_source text default '',
  landing_path text default '',
  duration_seconds int default 0,
  visit_time timestamptz default now()
);

create index if not exists idx_visit_log_time on public.visit_log(visit_time desc);

grant all privileges on table public.visit_log to service_role;
grant usage, select on sequence public.visit_log_id_seq to service_role;

alter table public.visit_log enable row level security;

drop policy if exists "service_role_all_visit_log" on public.visit_log;
create policy "service_role_all_visit_log" on public.visit_log
  for all to service_role using (true) with check (true);
