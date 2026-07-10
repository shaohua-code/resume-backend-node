-- ============================================================
-- 管理员用户归属与额度分配体系改造
-- 执行环境：Supabase Dashboard → SQL Editor
-- 幂等脚本，重复执行不会报错
-- ============================================================

-- ========== 1. 管理员-用户归属关系表 ==========
create table if not exists public.admin_user_relation (
  id bigserial primary key,
  admin_id uuid not null references auth.users(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  bind_type text not null check (bind_type in ('INVITE_LINK', 'EMAIL_CLAIM', 'LEGACY_MIGRATE')),
  create_time timestamptz default now(),
  unique (user_id)
);
create index if not exists idx_admin_user_relation_admin on public.admin_user_relation(admin_id);
create index if not exists idx_admin_user_relation_user on public.admin_user_relation(user_id);

-- ========== 2. 邀请链接表 ==========
create table if not exists public.invite_link (
  id bigserial primary key,
  admin_id uuid not null references auth.users(id) on delete cascade,
  code text not null unique,
  status text default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED')),
  expire_time timestamptz,
  used_count int default 0,
  create_time timestamptz default now()
);
create index if not exists idx_invite_link_admin on public.invite_link(admin_id);
create index if not exists idx_invite_link_code on public.invite_link(code);

-- ========== 3. 管理员额度池表 ==========
create table if not exists public.admin_quota_pool (
  admin_id uuid primary key references auth.users(id) on delete cascade,
  total_quota numeric(16, 4) not null default 0,
  allocated_quota numeric(16, 4) not null default 0,
  update_time timestamptz default now()
);

-- ========== 4. balance_ledger 新增实付金额字段 ==========
alter table public.balance_ledger
  add column if not exists paid_amount numeric(12, 4) default 0;

comment on column public.balance_ledger.paid_amount is '实付金额（用户实际支付给管理员的金额，仅 ADMIN_GRANT/ADMIN_ALLOCATE/ADMIN_POOL_GRANT 类型有值）';

-- ========== 5. 系统配置：超级管理员初始总额度池 ==========
insert into public.system_config (config_key, config_value, description)
values
  ('super_admin_total_quota', '{"amount": 1000000}'::jsonb, '超级管理员初始总额度池（元）')
on conflict (config_key) do nothing;

-- ========== 6. 授权与 RLS ==========
grant all privileges on table public.admin_user_relation to service_role;
grant all privileges on table public.invite_link to service_role;
grant all privileges on table public.admin_quota_pool to service_role;
grant usage, select on sequence public.admin_user_relation_id_seq to service_role;
grant usage, select on sequence public.invite_link_id_seq to service_role;

alter table public.admin_user_relation enable row level security;
alter table public.invite_link enable row level security;
alter table public.admin_quota_pool enable row level security;

drop policy if exists "service_role_all_admin_user_relation" on public.admin_user_relation;
create policy "service_role_all_admin_user_relation" on public.admin_user_relation
  for all to service_role using (true) with check (true);

drop policy if exists "service_role_all_invite_link" on public.invite_link;
create policy "service_role_all_invite_link" on public.invite_link
  for all to service_role using (true) with check (true);

drop policy if exists "service_role_all_admin_quota_pool" on public.admin_quota_pool;
create policy "service_role_all_admin_quota_pool" on public.admin_quota_pool
  for all to service_role using (true) with check (true);

-- ========== 7. 存量用户迁移：全部归属首个超级管理员 ==========
-- 找到最早的 SUPER_ADMIN，将所有未被归属的 USER 绑定到其名下
do $$
declare
  v_super_admin_id uuid;
begin
  -- 取第一个超级管理员（按创建时间最早）
  select user_id into v_super_admin_id
  from public.user_profile
  where role = 'SUPER_ADMIN'
  order by create_time asc
  limit 1;

  if v_super_admin_id is not null then
    -- 将所有不存在归属关系的 USER 批量绑定
    insert into public.admin_user_relation (admin_id, user_id, bind_type)
    select v_super_admin_id, up.user_id, 'LEGACY_MIGRATE'
    from public.user_profile up
    where up.role = 'USER'
      and not exists (
        select 1 from public.admin_user_relation aur where aur.user_id = up.user_id
      )
    on conflict do nothing;

    -- 为该超级管理员初始化额度池（若不存在）
    insert into public.admin_quota_pool (admin_id, total_quota, allocated_quota, update_time)
    values (v_super_admin_id, 1000000, 0, now())
    on conflict (admin_id) do nothing;
  end if;
end $$;

-- ========== 8. 验证（可选，执行后查看输出）==========
-- select count(*) from public.admin_user_relation;
-- select * from public.admin_quota_pool;
-- select column_name from information_schema.columns where table_name = 'balance_ledger' and column_name = 'paid_amount';
