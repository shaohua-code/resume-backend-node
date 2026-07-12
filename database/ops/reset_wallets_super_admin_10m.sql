-- ============================================================
-- 运维：清空余额/调用/导出/充值相关数据，超管重置为 1000 万
-- 保留：用户账号、简历、归属关系
-- 执行：node database/ops/run_reset_wallets_super_admin_10m.js
-- 警告：不可逆，执行前请备份
-- ============================================================

BEGIN;

-- 1. 清空余额流水、AI 调用、导出记录、充值申请（兼顾外键）
TRUNCATE TABLE
  public.recharge_request,
  public.balance_ledger,
  public.ai_call_record,
  public.export_record
RESTART IDENTITY;

-- 2. 全员钱包归零
UPDATE public.user_wallet
SET balance = 0, total_consumed = 0, update_time = now();

-- 3. 超管初始额度配置改为 1000 万
UPDATE public.system_config
SET config_value = '{"amount": 10000000}'::jsonb, update_time = now()
WHERE config_key = 'super_admin_total_quota';

INSERT INTO public.system_config (config_key, config_value, description, update_time)
VALUES ('super_admin_total_quota', '{"amount": 10000000}'::jsonb, '超级管理员初始总额度池（元）', now())
ON CONFLICT (config_key) DO UPDATE
SET config_value = '{"amount": 10000000}'::jsonb, update_time = now();

-- 4. 注册赠送保持 ¥10
INSERT INTO public.system_config (config_key, config_value, description, update_time)
VALUES ('register_gift_amount', '{"amount": 10}'::jsonb, '新用户注册赠送额度（元）', now())
ON CONFLICT (config_key) DO UPDATE
SET config_value = '{"amount": 10}'::jsonb, update_time = now();

-- 5. 首个 SUPER_ADMIN 余额设为 10000000
DO $$
DECLARE
  v_super_admin_id uuid;
BEGIN
  SELECT user_id INTO v_super_admin_id
  FROM public.user_profile
  WHERE role = 'SUPER_ADMIN'
  ORDER BY create_time ASC
  LIMIT 1;

  IF v_super_admin_id IS NULL THEN
    RAISE NOTICE '未找到 SUPER_ADMIN，跳过超管额度设置';
    RETURN;
  END IF;

  INSERT INTO public.user_wallet (user_id, balance, total_consumed, update_time)
  VALUES (v_super_admin_id, 10000000, 0, now())
  ON CONFLICT (user_id) DO UPDATE
    SET balance = 10000000, total_consumed = 0, update_time = now();

  RAISE NOTICE '超管 % 余额已重置为 10000000', v_super_admin_id;
END $$;

COMMIT;
