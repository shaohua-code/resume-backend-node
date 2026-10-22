-- JD 图片识图：DeepSeek Flash Vision，删除 DashScope/Qwen 模型
-- 适用：已有生产/测试库（新库可直接用 init.sql）
-- 建议：先备份；在维护窗口执行；执行后重启后端并确认 .env 已移除 DASHSCOPE_*

BEGIN;

INSERT INTO public.ai_model (
  name, model_key, task_type, provider, model_type, api_key_env,
  input_price_per_million, cached_input_price_per_million, output_price_per_million,
  official_input_price_per_million, official_cached_input_price_per_million, official_output_price_per_million,
  thinking_enabled, enabled
)
VALUES (
  'DeepSeek Flash Vision', 'deepseek-flash', 'all', 'deepseek', 'vision', 'DEEPSEEK_API_KEY',
  1.0, 0.1, 2.0, 1.0, 0.1, 2.0, false, true
)
ON CONFLICT (model_key) DO UPDATE SET
  name = EXCLUDED.name,
  provider = EXCLUDED.provider,
  model_type = EXCLUDED.model_type,
  api_key_env = EXCLUDED.api_key_env,
  input_price_per_million = EXCLUDED.input_price_per_million,
  cached_input_price_per_million = EXCLUDED.cached_input_price_per_million,
  output_price_per_million = EXCLUDED.output_price_per_million,
  official_input_price_per_million = EXCLUDED.official_input_price_per_million,
  official_cached_input_price_per_million = EXCLUDED.official_cached_input_price_per_million,
  official_output_price_per_million = EXCLUDED.official_output_price_per_million,
  thinking_enabled = EXCLUDED.thinking_enabled,
  enabled = EXCLUDED.enabled,
  update_time = now();

UPDATE public.ai_task_model task_map
SET model_id = vision_model.id,
    required_model_type = 'vision',
    thinking_enabled = false,
    update_time = now()
FROM public.ai_model vision_model
WHERE task_map.task_type = 'jd_image_extract'
  AND vision_model.model_key = 'deepseek-flash';

UPDATE public.ai_task_model task_map
SET model_id = vision_model.id,
    update_time = now()
FROM public.ai_model vision_model, public.ai_model legacy
WHERE vision_model.model_key = 'deepseek-flash'
  AND legacy.id = task_map.model_id
  AND (legacy.provider = 'dashscope' OR legacy.model_key = 'qwen3.6-flash');

UPDATE public.user_ai_task_model user_map
SET model_id = vision_model.id,
    update_time = now()
FROM public.ai_model vision_model
WHERE vision_model.model_key = 'deepseek-flash'
  AND user_map.model_id IN (
    SELECT id FROM public.ai_model WHERE provider = 'dashscope' OR model_key = 'qwen3.6-flash'
  );

DELETE FROM public.ai_model
WHERE provider = 'dashscope' OR model_key = 'qwen3.6-flash';

COMMIT;

-- 验收（可选，只读）：
-- SELECT task_type, m.model_key, m.provider FROM ai_task_model t JOIN ai_model m ON m.id = t.model_id WHERE task_type = 'jd_image_extract';
-- SELECT model_key, provider, enabled FROM ai_model WHERE provider = 'dashscope' OR model_key LIKE 'qwen%';
