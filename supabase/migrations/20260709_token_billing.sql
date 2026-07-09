-- Token 计费体系：用户钱包与余额流水
-- 执行后请确认 service_role 已授权

-- 用户钱包表：每个用户一条记录，记录当前余额与累计消费
create table if not exists public.user_wallet (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance numeric(12, 4) not null default 0,
  total_consumed numeric(12, 4) not null default 0,
  update_time timestamptz default now()
);

-- 余额流水表：记录注册赠送、管理员增减、AI 消费等变动
create table if not exists public.balance_ledger (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  amount numeric(12, 4) not null,
  balance_after numeric(12, 4) not null,
  remark text default '',
  operator_id uuid references auth.users(id) on delete set null,
  ai_call_id bigint references public.ai_call_record(id) on delete set null,
  create_time timestamptz default now()
);

create index if not exists idx_balance_ledger_user_time on public.balance_ledger(user_id, create_time desc);
create index if not exists idx_balance_ledger_type on public.balance_ledger(type);

-- 新用户注册赠送金额配置（超级管理员可在后台修改）
insert into public.system_config (config_key, config_value, description)
values
  ('register_gift_amount', '{"amount": 10}'::jsonb, '新用户注册赠送额度（元）')
on conflict (config_key) do nothing;

-- 授权与 RLS
grant all privileges on table public.user_wallet to service_role;
grant all privileges on table public.balance_ledger to service_role;
grant usage, select on sequence public.balance_ledger_id_seq to service_role;

alter table public.user_wallet enable row level security;
alter table public.balance_ledger enable row level security;

drop policy if exists "service_role_all_user_wallet" on public.user_wallet;
create policy "service_role_all_user_wallet" on public.user_wallet
  for all to service_role using (true) with check (true);

drop policy if exists "service_role_all_balance_ledger" on public.balance_ledger;
create policy "service_role_all_balance_ledger" on public.balance_ledger
  for all to service_role using (true) with check (true);
