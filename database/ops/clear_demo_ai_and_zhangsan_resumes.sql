-- ============================================================
-- 运维：清理测试脏数据（AI 调用记录 + 「张三」测试简历）
-- 保留：用户账号、钱包余额、流水、归属关系
-- 执行：psql "$DATABASE_URL" -f database/ops/clear_demo_ai_and_zhangsan_resumes.sql
-- ============================================================

BEGIN;

-- 1. 解除流水对 AI 调用的外键引用，再删除 AI 调用记录
UPDATE public.balance_ledger
SET ai_call_id = NULL
WHERE ai_call_id IS NOT NULL;

DELETE FROM public.ai_call_record;

-- 重置自增（若有序列）
SELECT setval(
  pg_get_serial_sequence('public.ai_call_record', 'id'),
  1,
  false
);

-- 2. 删除标题含「张三」的测试简历
DELETE FROM public.export_record
WHERE resume_id IN (
  SELECT id FROM public.resume WHERE title LIKE '%张三%'
);

DELETE FROM public.resume
WHERE title LIKE '%张三%';

COMMIT;
