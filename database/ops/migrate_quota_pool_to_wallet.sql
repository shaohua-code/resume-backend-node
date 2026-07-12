-- ============================================================
-- 一次性迁移：额度池 → 统一 wallet.balance
-- 将 admin_quota_pool 的 available（total - allocated）合并入 user_wallet.balance
-- 执行后删除 admin_quota_pool 表
-- 执行：psql -h 127.0.0.1 -U ai_resume -d ai_resume -f database/ops/migrate_quota_pool_to_wallet.sql
-- ============================================================

-- 1. 将额度池剩余可用额度合并到对应管理员/超管的 wallet.balance
DO $$
DECLARE
  v_row record;
  v_available numeric;
BEGIN
  FOR v_row IN SELECT admin_id, total_quota, allocated_quota FROM public.admin_quota_pool
  LOOP
    v_available := GREATEST(0, COALESCE(v_row.total_quota, 0) - COALESCE(v_row.allocated_quota, 0));

    INSERT INTO public.user_wallet (user_id, balance, total_consumed, update_time)
    VALUES (v_row.admin_id, v_available, 0, now())
    ON CONFLICT (user_id) DO UPDATE
      SET balance = public.user_wallet.balance + v_available,
          update_time = now();
  END LOOP;
END $$;

-- 2. 删除额度池表
DROP TABLE IF EXISTS public.admin_quota_pool;
