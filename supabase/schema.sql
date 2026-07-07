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

-- ============================================================
-- 权限后台扩展表
-- 执行说明：用户首次登录后会自动写入 user_profile，再手动把指定邮箱改为 SUPER_ADMIN
-- ============================================================

-- 用户资料与角色表：业务角色不直接写入 auth.users，便于后续扩展会员和封禁状态
create table if not exists public.user_profile (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  nickname text default '',
  role text not null default 'USER' check (role in ('SUPER_ADMIN', 'ADMIN', 'USER', 'VIP')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'BANNED')),
  vip_expire_time timestamptz,
  create_time timestamptz default now(),
  update_time timestamptz default now()
);
create index if not exists idx_user_profile_role on public.user_profile(role);
create index if not exists idx_user_profile_status on public.user_profile(status);
create index if not exists idx_user_profile_email on public.user_profile(email);

-- 会员套餐表：后台配置用户可购买或管理员可调整的会员方案
create table if not exists public.membership_plan (
  id bigserial primary key,
  name text not null,
  price numeric(10, 2) not null default 0,
  duration_days int not null default 30,
  description text default '',
  enabled boolean default true,
  create_time timestamptz default now(),
  update_time timestamptz default now()
);

-- 订单表：记录会员套餐购买和后台补单等业务订单
create table if not exists public.order_record (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete set null,
  plan_id bigint references public.membership_plan(id) on delete set null,
  order_no text unique not null,
  amount numeric(10, 2) not null default 0,
  status text not null default 'PENDING' check (status in ('PENDING', 'PAID', 'CANCELLED', 'REFUNDED')),
  pay_time timestamptz,
  create_time timestamptz default now(),
  update_time timestamptz default now()
);
create index if not exists idx_order_record_user_id on public.order_record(user_id);
create index if not exists idx_order_record_status on public.order_record(status);

-- AI调用记录表：用于普通用户每日次数限制、后台审计和统计
create table if not exists public.ai_call_record (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete set null,
  task_type text not null,
  model text default '',
  prompt_tokens int default 0,
  completion_tokens int default 0,
  total_tokens int default 0,
  cost numeric(10, 6) default 0,
  success boolean default true,
  error_message text default '',
  create_time timestamptz default now()
);
create index if not exists idx_ai_call_record_user_task_time on public.ai_call_record(user_id, task_type, create_time);

-- 系统配置表：保存每日AI次数、默认模型等可运营配置
create table if not exists public.system_config (
  config_key text primary key,
  config_value jsonb not null default '{}'::jsonb,
  description text default '',
  update_time timestamptz default now()
);

-- 公告表：用于前台公告、运营通知等内容管理
create table if not exists public.announcement (
  id bigserial primary key,
  title text not null,
  content text not null default '',
  enabled boolean default true,
  create_time timestamptz default now(),
  update_time timestamptz default now()
);

-- AI模型表：后台配置可选模型，并标记是否仅VIP可用
create table if not exists public.ai_model (
  id bigserial primary key,
  name text not null,
  model_key text unique not null,
  task_type text default 'all',
  input_price_per_million numeric(10, 4) default 0,
  output_price_per_million numeric(10, 4) default 0,
  vip_only boolean default false,
  enabled boolean default true,
  create_time timestamptz default now(),
  update_time timestamptz default now()
);

-- 管理员操作日志：记录关键后台操作，便于后续审计
create table if not exists public.admin_action_log (
  id bigserial primary key,
  admin_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text default '',
  target_id text default '',
  create_time timestamptz default now()
);
create index if not exists idx_admin_action_log_admin_time on public.admin_action_log(admin_user_id, create_time);

-- 默认数据：首次执行后即可在后台看到基础套餐、AI模型和AI次数配置
insert into public.membership_plan (name, price, duration_days, description, enabled)
values
  ('月度VIP', 19.90, 30, '解锁不限次数AI、导出和高级模板', true),
  ('年度VIP', 199.00, 365, '一年内解锁全部VIP能力', true)
on conflict do nothing;

insert into public.system_config (config_key, config_value, description)
values
  ('ai_daily_limit', '{"USER": 3, "VIP": -1}'::jsonb, '普通用户每日每类AI调用次数，-1表示不限次数')
on conflict (config_key) do nothing;

insert into public.ai_model (name, model_key, task_type, input_price_per_million, output_price_per_million, vip_only, enabled)
values
  ('DeepSeek 默认模型', 'deepseek-v4-flash', 'all', 0.5, 2.0, false, true),
  ('DeepSeek 高级模型', 'deepseek-chat', 'all', 2.0, 8.0, true, true)
on conflict (model_key) do nothing;

-- 给 service_role 授权，后端使用 service_role 统一访问这些业务表
grant all privileges on table public.user_profile to service_role;
grant all privileges on table public.membership_plan to service_role;
grant all privileges on table public.order_record to service_role;
grant all privileges on table public.ai_call_record to service_role;
grant all privileges on table public.system_config to service_role;
grant all privileges on table public.announcement to service_role;
grant all privileges on table public.ai_model to service_role;
grant all privileges on table public.admin_action_log to service_role;
grant all privileges on all sequences in schema public to service_role;

-- 启用 RLS，并仅放行后端 service_role；前端不得直接绕过接口访问管理数据
alter table public.user_profile enable row level security;
alter table public.membership_plan enable row level security;
alter table public.order_record enable row level security;
alter table public.ai_call_record enable row level security;
alter table public.system_config enable row level security;
alter table public.announcement enable row level security;
alter table public.ai_model enable row level security;
alter table public.admin_action_log enable row level security;

drop policy if exists "service_role_all_user_profile" on public.user_profile;
create policy "service_role_all_user_profile" on public.user_profile
  for all to service_role using (true) with check (true);

drop policy if exists "service_role_all_membership_plan" on public.membership_plan;
create policy "service_role_all_membership_plan" on public.membership_plan
  for all to service_role using (true) with check (true);

drop policy if exists "service_role_all_order_record" on public.order_record;
create policy "service_role_all_order_record" on public.order_record
  for all to service_role using (true) with check (true);

drop policy if exists "service_role_all_ai_call_record" on public.ai_call_record;
create policy "service_role_all_ai_call_record" on public.ai_call_record
  for all to service_role using (true) with check (true);

drop policy if exists "service_role_all_system_config" on public.system_config;
create policy "service_role_all_system_config" on public.system_config
  for all to service_role using (true) with check (true);

drop policy if exists "service_role_all_announcement" on public.announcement;
create policy "service_role_all_announcement" on public.announcement
  for all to service_role using (true) with check (true);

drop policy if exists "service_role_all_ai_model" on public.ai_model;
create policy "service_role_all_ai_model" on public.ai_model
  for all to service_role using (true) with check (true);

drop policy if exists "service_role_all_admin_action_log" on public.admin_action_log;
create policy "service_role_all_admin_action_log" on public.admin_action_log
  for all to service_role using (true) with check (true);

-- 用户反馈表：富文本 HTML + Markdown 预览内容
create table if not exists public.user_feedback (
  id           bigserial primary key,
  user_id      uuid references auth.users(id) on delete set null,
  content_html text not null default '',
  content_md   text not null default '',
  create_time  timestamptz default now()
);
create index if not exists idx_user_feedback_user_id on public.user_feedback(user_id);
create index if not exists idx_user_feedback_create_time on public.user_feedback(create_time desc);

alter table public.user_feedback enable row level security;
drop policy if exists "service_role_all_user_feedback" on public.user_feedback;
create policy "service_role_all_user_feedback" on public.user_feedback
  for all to service_role using (true) with check (true);
grant all privileges on table public.user_feedback to service_role;

-- 超级管理员初始化：先登录一次，再把下面邮箱替换成你的管理员邮箱执行
-- update public.user_profile
-- set role = 'SUPER_ADMIN', status = 'ACTIVE', update_time = now()
-- where email = '你的超级管理员邮箱@example.com';
