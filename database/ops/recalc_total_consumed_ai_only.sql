-- 回填：total_consumed 仅统计 AI_CONSUME 扣费，不含额度发放等其它扣款
-- 部署后执行一次，使「累计消费」卡片与余额变动趋势 AI 消费口径一致

UPDATE public.user_wallet w
SET
  total_consumed = COALESCE(s.ai_consumed, 0),
  update_time = now()
FROM (
  SELECT
    user_id,
    ROUND(SUM(ABS(amount))::numeric, 4) AS ai_consumed
  FROM public.balance_ledger
  WHERE type = 'AI_CONSUME'
    AND amount < 0
  GROUP BY user_id
) s
WHERE w.user_id = s.user_id;

-- 无 AI 消费流水的用户归零（避免残留发放扣款污染）
UPDATE public.user_wallet w
SET
  total_consumed = 0,
  update_time = now()
WHERE NOT EXISTS (
  SELECT 1
  FROM public.balance_ledger l
  WHERE l.user_id = w.user_id
    AND l.type = 'AI_CONSUME'
    AND l.amount < 0
);
