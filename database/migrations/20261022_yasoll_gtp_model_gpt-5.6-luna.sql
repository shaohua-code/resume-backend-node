-- Yasoll 第三方 GTP 模型：调用 Key 统一为 gpt-5.6-luna
-- 适用：管理端已配置 provider=yasoll 的文本模型（如 gtp-plus / gpt-5.5）
-- 任务绑定仍指向同一 ai_model.id，无需改 ai_task_model

BEGIN;

UPDATE public.ai_model
SET model_key = 'gpt-5.6-luna',
    name = 'gtp-plus',
    update_time = now()
WHERE provider = 'yasoll'
  AND (
    model_key IN ('gpt-5.5', 'gpt-5.6 Sol', 'gpt-5.6-sol', 'gtp-plus', 'gpt-5.6-luna')
    OR name ILIKE 'gtp%'
    OR model_key ILIKE 'gpt-5%'
  );

COMMIT;

-- 验收（可选）：
-- SELECT id, name, model_key, provider, api_url FROM ai_model WHERE provider = 'yasoll';
