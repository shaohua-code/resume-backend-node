-- ============================================================
-- 运维脚本：清空所有用户额度 + 所有消费记录，超管重置为 100 万
-- 统一 balance 模型（无额度池）
-- 执行：psql -h 127.0.0.1 -U ai_resume -d ai_resume -f database/ops/reset_all_quota_and_ledger.sql
-- 警告：不可逆，执行前请备份 balance_ledger / ai_call_record / user_wallet
-- ============================================================

-- 1. 清空所有消费流水与 AI 调用记录
TRUNCATE TABLE public.balance_ledger, public.ai_call_record RESTART IDENTITY;

-- 2. 所有用户（含管理员）余额与累计消费归零
UPDATE public.user_wallet
  SET balance = 0, total_consumed = 0, update_time = now();

-- 3. 更新系统配置：超管初始额度 = 100 万
UPDATE public.system_config
  SET config_value = '{"amount": 1000000}'::jsonb, update_time = now()
  WHERE config_key = 'super_admin_total_quota';

-- 4. 为首个 SUPER_ADMIN 设置余额 100 万
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
  VALUES (v_super_admin_id, 1000000, 0, now())
  ON CONFLICT (user_id) DO UPDATE
    SET balance = 1000000, total_consumed = 0, update_time = now();

  RAISE NOTICE '超管 % 余额已重置为 1000000', v_super_admin_id;
END $$;
