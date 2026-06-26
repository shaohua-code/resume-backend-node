-- ============================================================
-- Supabase 新版 API Key（sb_secret_xxx）授权 + 建表完整脚本
-- 执行环境：Supabase Dashboard → SQL Editor
-- 一次性执行即可，幂等（重复执行不会报错）
-- ============================================================

-- ========== 1. 创建数据表 ==========
create table if not exists public.resume (
  id          bigserial primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text default '未命名简历',
  resume_json text default '{}',
  template_id int  default 1,
  score       int  default 0,
  create_time timestamptz default now(),
  update_time timestamptz default now()
);
create index if not exists idx_resume_user_id on public.resume(user_id);

create table if not exists public.export_record (
  id          bigserial primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  resume_id   bigint not null references public.resume(id) on delete cascade,
  create_time timestamptz default now()
);
create index if not exists idx_export_user_id on public.export_record(user_id);

-- ========== 2. 关键：给 service_role 角色授权（解决 permission denied）==========
-- 新版 sb_secret_xxx 内部映射到 service_role 角色
-- 必须显式授权 schema 与表的访问权
grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all functions in schema public to service_role;

-- 让以后新建的表也自动授权给 service_role
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;

-- 单独再给一次（兜底，防万一上面的 all tables 没生效）
grant all privileges on table public.resume to service_role;
grant all privileges on table public.export_record to service_role;

-- ========== 3. 启用 RLS 并放行 service_role ==========
alter table public.resume enable row level security;
alter table public.export_record enable row level security;

drop policy if exists "service_role_all_resume" on public.resume;
create policy "service_role_all_resume" on public.resume
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "service_role_all_export" on public.export_record;
create policy "service_role_all_export" on public.export_record
  for all
  to service_role
  using (true)
  with check (true);

-- ========== 4. 验证授权（可选，执行后查看输出）==========
-- select grantee, privilege_type
-- from information_schema.role_table_grants
-- where table_name in ('resume', 'export_record');
