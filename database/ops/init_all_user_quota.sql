-- ============================================================
-- 运维脚本：初始化所有用户额度（幂等，可重复执行）
-- 统一 balance 模型：超管 wallet = 100 万，用户获得注册赠送，从超管扣减
-- 执行：psql -h 127.0.0.1 -U ai_resume -d ai_resume -f database/ops/init_all_user_quota.sql
-- ============================================================

-- 1. 清空流水与 AI 调用记录
TRUNCATE TABLE public.balance_ledger, public.ai_call_record RESTART IDENTITY;

-- 2. 所有钱包余额/消费归零
UPDATE public.user_wallet
  SET balance = 0, total_consumed = 0, update_time = now();

-- 3. 重置超管初始额度配置为 100 万
UPDATE public.system_config
  SET config_value = '{"amount": 1000000}'::jsonb, update_time = now()
  WHERE config_key = 'super_admin_total_quota';

-- 4. 为首个 SUPER_ADMIN 设置初始额度 100 万
DO $$
DECLARE
  v_super_admin_id uuid;
  v_user_count int;
  v_gift_amount numeric;
  v_total_gift numeric;
BEGIN
  SELECT COALESCE((config_value->>'amount')::numeric, 10) INTO v_gift_amount
  FROM public.system_config
  WHERE config_key = 'register_gift_amount';

  SELECT user_id INTO v_super_admin_id
  FROM public.user_profile WHERE role = 'SUPER_ADMIN'
  ORDER BY create_time ASC LIMIT 1;

  IF v_super_admin_id IS NULL THEN RETURN; END IF;

  SELECT count(*) INTO v_user_count FROM public.user_profile WHERE role = 'USER';
  v_total_gift := v_user_count * v_gift_amount;

  -- 超管余额 = 100 万 - 已赠送给现有用户的总额
  INSERT INTO public.user_wallet (user_id, balance, total_consumed, update_time)
  VALUES (v_super_admin_id, GREATEST(0, 1000000 - v_total_gift), 0, now())
  ON CONFLICT (user_id) DO UPDATE
    SET balance = GREATEST(0, 1000000 - v_total_gift), total_consumed = 0, update_time = now();
END $$;

-- 5. 为所有 USER 角色用户写入注册赠送余额与流水
DO $$
DECLARE
  v_super_admin_id uuid;
  v_gift_amount numeric;
  v_user_record record;
BEGIN
  SELECT COALESCE((config_value->>'amount')::numeric, 10) INTO v_gift_amount
  FROM public.system_config
  WHERE config_key = 'register_gift_amount';

  SELECT user_id INTO v_super_admin_id
  FROM public.user_profile WHERE role = 'SUPER_ADMIN'
  ORDER BY create_time ASC LIMIT 1;

  IF v_super_admin_id IS NULL THEN RETURN; END IF;

  FOR v_user_record IN SELECT user_id FROM public.user_profile WHERE role = 'USER'
  LOOP
    INSERT INTO public.user_wallet (user_id, balance, total_consumed, update_time)
    VALUES (v_user_record.user_id, v_gift_amount, 0, now())
    ON CONFLICT (user_id) DO UPDATE
      SET balance = v_gift_amount, total_consumed = 0, update_time = now();

    INSERT INTO public.balance_ledger (user_id, type, amount, balance_after, remark, operator_id, paid_amount, create_time)
    VALUES (
      v_user_record.user_id,
      'REGISTER_GIFT',
      v_gift_amount,
      v_gift_amount,
      '系统初始化：重新分配 ' || v_gift_amount || ' 元',
      v_super_admin_id,
      0,
      now()
    );
  END LOOP;
END $$;
