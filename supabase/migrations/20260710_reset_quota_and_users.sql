-- ============================================================
-- 重置所有用户额度与用量记录
-- 执行环境：Supabase Dashboard → SQL Editor
-- 作用：清空所有用户钱包余额、流水记录、AI 调用记录，
--       重置超管额度池为 1000000，给所有 USER 角色用户分配 10 元
-- 注意：此脚本不可逆，执行前请确认！
-- ============================================================

-- ========== 1. 清空所有用量记录 ==========
-- 删除 AI 调用记录与余额流水记录（balance_ledger 通过 ai_call_id 外键引用 ai_call_record，必须同时 truncate）
-- 同时清空后重置自增 ID
truncate table public.balance_ledger, public.ai_call_record restart identity;

-- ========== 2. 重置所有用户钱包余额 ==========
-- 余额清零、累计消费清零
update public.user_wallet
  set balance = 0,
      total_consumed = 0,
      update_time = now();

-- ========== 3. 重置所有管理员额度池 ==========
-- 删除所有额度池记录（包括超管和管理员的）
delete from public.admin_quota_pool;

-- 更新系统配置：总额度池 1000000
update public.system_config
  set config_value = '{"amount": 1000000}'::jsonb
  where config_key = 'super_admin_total_quota';

-- ========== 4. 为首个超级管理员重建额度池 ==========
do $$
declare
  v_super_admin_id uuid;
  v_user_count int;
  v_gift_amount numeric := 10;
  v_total_gift numeric;
begin
  -- 取第一个超级管理员（按创建时间最早）
  select user_id into v_super_admin_id
  from public.user_profile
  where role = 'SUPER_ADMIN'
  order by create_time asc
  limit 1;

  if v_super_admin_id is null then
    raise notice '未找到超级管理员，跳过额度池初始化';
    return;
  end if;

  -- 统计需要分配赠送的 USER 用户数
  select count(*) into v_user_count
  from public.user_profile
  where role = 'USER';

  -- 计算赠送总额
  v_total_gift := v_user_count * v_gift_amount;

  -- 创建超管额度池：total_quota=1000000，allocated_quota=已赠送出去的金额
  insert into public.admin_quota_pool (admin_id, total_quota, allocated_quota, update_time)
  values (v_super_admin_id, 1000000, v_total_gift, now())
  on conflict (admin_id) do update
    set total_quota = 1000000,
        allocated_quota = v_total_gift,
        update_time = now();

  raise notice '超管额度池已重建：总额度 1000000，已分配 %', v_total_gift;
end $$;

-- ========== 5. 给所有 USER 用户分配 10 元 ==========
do $$
declare
  v_super_admin_id uuid;
  v_gift_amount numeric := 10;
  v_user_record record;
begin
  -- 取第一个超级管理员
  select user_id into v_super_admin_id
  from public.user_profile
  where role = 'SUPER_ADMIN'
  order by create_time asc
  limit 1;

  if v_super_admin_id is null then
    raise notice '未找到超级管理员，跳过用户赠送';
    return;
  end if;

  -- 遍历所有 USER 角色用户
  for v_user_record in
    select user_id from public.user_profile where role = 'USER'
  loop
    -- 更新或创建用户钱包：余额设为 10
    insert into public.user_wallet (user_id, balance, total_consumed, update_time)
    values (v_user_record.user_id, v_gift_amount, 0, now())
    on conflict (user_id) do update
      set balance = v_gift_amount,
          total_consumed = 0,
          update_time = now();

    -- 写入赠送流水（balance_after = 10）
    insert into public.balance_ledger (user_id, type, amount, balance_after, remark, operator_id, paid_amount, create_time)
    values (v_user_record.user_id, 'REGISTER_GIFT', v_gift_amount, v_gift_amount, '系统重置：重新分配 10 元', v_super_admin_id, 0, now());
  end loop;

  raise notice '所有 USER 用户已分配 % 元', v_gift_amount;
end $$;

-- ========== 6. 验证查询（执行后查看输出） ==========
-- select * from public.admin_quota_pool;  -- 应显示超管 total_quota=1000000, allocated_quota=用户数*10
-- select count(*) as user_count from public.user_profile where role = 'USER';  -- USER 用户数
-- select count(*) as ledger_count from public.balance_ledger;  -- 应等于 USER 用户数
-- select count(*) as wallet_count from public.user_wallet where balance > 0;  -- 应等于 USER 用户数
-- select sum(balance) as total_balance from public.user_wallet;  -- 应等于 USER 用户数 * 10
-- select count(*) from public.ai_call_record;  -- 应为 0
