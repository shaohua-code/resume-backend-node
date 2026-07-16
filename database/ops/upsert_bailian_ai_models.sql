-- Reset and seed AI model prices for the admin AI model table.
--
-- Checked on 2026-07-16 from Bailian console documentation:
-- https://bailian.console.aliyun.com/cn-beijing?tab=doc#/doc/?type=model&url=2987148
--
-- Price columns are CNY per 1M tokens.
-- For tiered models, this file stores the first official tier because the current
-- ai_model table has only one input/output price pair. This matches ordinary
-- resume/JD requests. Limited-time discounts are not encoded because they expire.
-- Doubao/豆包 was not listed on this Bailian pricing page at check time, so it is
-- not inserted here to avoid creating an invalid model_key.

BEGIN;

-- Full reset: remove all task assignments first because ai_task_model references
-- ai_model. ai_call_record stores model names as text and is not affected.
DELETE FROM public.ai_task_model;
DELETE FROM public.ai_model;

INSERT INTO public.ai_model (
  name,
  model_key,
  task_type,
  provider,
  model_type,
  api_url,
  api_key_env,
  input_price_per_million,
  cached_input_price_per_million,
  output_price_per_million,
  thinking_enabled,
  enabled,
  update_time
)
VALUES
  -- Existing initializer models.
  ('DeepSeek V4 Flash', 'deepseek-v4-flash', 'all', 'dashscope', 'text', '', 'DASHSCOPE_API_KEY', 1.0000, 0.1000, 2.0000, NULL, true, now()),
  ('DeepSeek Chat (legacy alias)', 'deepseek-chat', 'all', 'deepseek', 'text', '', 'DEEPSEEK_API_KEY', 1.0000, 0.1000, 2.0000, NULL, false, now()),
  ('Qwen3.6 Flash Vision', 'qwen3.6-flash', 'all', 'dashscope', 'vision', '', 'DASHSCOPE_API_KEY', 1.2000, 0.1200, 7.2000, false, true, now()),

  -- Text models: multi-vendor strong general capability.
  ('Qwen3.7 Plus', 'qwen3.7-plus', 'all', 'dashscope', 'text', '', 'DASHSCOPE_API_KEY', 2.0000, 0.2000, 8.0000, false, true, now()),
  ('DeepSeek V4 Pro', 'deepseek-v4-pro', 'all', 'dashscope', 'text', '', 'DASHSCOPE_API_KEY', 12.0000, 1.2000, 24.0000, NULL, true, now()),
  ('DeepSeek V3.2', 'deepseek-v3.2', 'all', 'dashscope', 'text', '', 'DASHSCOPE_API_KEY', 2.0000, 0.2000, 3.0000, NULL, true, now()),
  ('DeepSeek R1', 'deepseek-r1', 'all', 'dashscope', 'text', '', 'DASHSCOPE_API_KEY', 4.0000, 4.0000, 16.0000, true, true, now()),
  ('Kimi K2.7 Code', 'kimi-k2.7-code', 'all', 'dashscope', 'text', '', 'DASHSCOPE_API_KEY', 6.5000, 6.5000, 27.0000, true, true, now()),
  ('Kimi K2.6', 'kimi-k2.6', 'all', 'dashscope', 'text', '', 'DASHSCOPE_API_KEY', 6.5000, 6.5000, 27.0000, NULL, true, now()),
  ('Moonshot Kimi K2 Instruct', 'Moonshot-Kimi-K2-Instruct', 'all', 'dashscope', 'text', '', 'DASHSCOPE_API_KEY', 4.0000, 4.0000, 16.0000, false, true, now()),
  ('GLM 5.2', 'glm-5.2', 'all', 'dashscope', 'text', '', 'DASHSCOPE_API_KEY', 8.0000, 8.0000, 28.0000, NULL, true, now()),
  ('GLM 5', 'glm-5', 'all', 'dashscope', 'text', '', 'DASHSCOPE_API_KEY', 4.0000, 4.0000, 18.0000, NULL, true, now()),
  ('MiniMax M2.5', 'MiniMax-M2.5', 'all', 'dashscope', 'text', '', 'DASHSCOPE_API_KEY', 2.1000, 2.1000, 8.4000, true, true, now()),
  ('MiniMax M3', 'MiniMax/MiniMax-M3', 'all', 'dashscope', 'text', '', 'DASHSCOPE_API_KEY', 4.2000, 0.4200, 16.8000, NULL, true, now()),
  ('Stepfun Step 3.7 Flash', 'stepfun/step-3.7-flash', 'all', 'dashscope', 'text', '', 'DASHSCOPE_API_KEY', 1.3500, 1.3500, 8.1000, NULL, true, now()),

  -- Vision/OCR/reasoning models.
  ('Qwen3 VL Plus', 'qwen3-vl-plus', 'all', 'dashscope', 'vision', '', 'DASHSCOPE_API_KEY', 1.0000, 0.1000, 10.0000, false, true, now()),
  ('Qwen3 VL Flash', 'qwen3-vl-flash', 'all', 'dashscope', 'vision', '', 'DASHSCOPE_API_KEY', 0.1500, 0.0150, 1.5000, false, true, now()),
  ('Qwen VL Max', 'qwen-vl-max', 'all', 'dashscope', 'vision', '', 'DASHSCOPE_API_KEY', 1.6000, 0.1600, 4.0000, NULL, true, now()),
  ('Qwen VL Plus', 'qwen-vl-plus', 'all', 'dashscope', 'vision', '', 'DASHSCOPE_API_KEY', 0.8000, 0.0800, 2.0000, NULL, true, now()),
  ('Qwen VL OCR Latest', 'qwen-vl-ocr-latest', 'all', 'dashscope', 'vision', '', 'DASHSCOPE_API_KEY', 0.3000, 0.3000, 0.5000, NULL, true, now()),
  ('Qwen VL OCR 2025-11-20', 'qwen-vl-ocr-2025-11-20', 'all', 'dashscope', 'vision', '', 'DASHSCOPE_API_KEY', 0.3000, 0.3000, 0.5000, NULL, true, now()),
  ('Qwen VL OCR 2025-08-28', 'qwen-vl-ocr-2025-08-28', 'all', 'dashscope', 'vision', '', 'DASHSCOPE_API_KEY', 5.0000, 5.0000, 5.0000, NULL, true, now()),
  ('DeepSeek OCR (Vanchin)', 'vanchin/deepseek-ocr', 'all', 'dashscope', 'vision', '', 'DASHSCOPE_API_KEY', 0.2160, 0.2160, 0.2160, NULL, true, now()),
  ('QVQ Max', 'qvq-max', 'all', 'dashscope', 'vision', '', 'DASHSCOPE_API_KEY', 8.0000, 8.0000, 32.0000, true, true, now()),
  ('QVQ Plus', 'qvq-plus', 'all', 'dashscope', 'vision', '', 'DASHSCOPE_API_KEY', 2.0000, 2.0000, 5.0000, true, true, now())
ON CONFLICT (model_key) DO NOTHING;

-- Defaults for this resume app:
-- text: glm-5.2 is selected as the default strong multi-vendor text model.
-- vision: qwen-vl-ocr-latest is best suited to JD screenshot/OCR extraction cost.
INSERT INTO public.ai_task_model (task_type, required_model_type, model_id, update_time)
SELECT task.task_type, task.required_model_type, model.id, now()
FROM (VALUES
  ('resume_generate', 'text', 'glm-5.2'),
  ('project_optimize', 'text', 'glm-5.2'),
  ('summary_optimize', 'text', 'glm-5.2'),
  ('skills_optimize', 'text', 'glm-5.2'),
  ('internship_optimize', 'text', 'glm-5.2'),
  ('work_experience_optimize', 'text', 'glm-5.2'),
  ('jd_match', 'text', 'glm-5.2'),
  ('score', 'text', 'glm-5.2'),
  ('pdf_optimize', 'text', 'glm-5.2'),
  ('jd_resume_optimize', 'text', 'glm-5.2'),
  ('pdf_jd_optimize', 'text', 'glm-5.2'),
  ('jd_image_extract', 'vision', 'qwen-vl-ocr-latest')
) AS task(task_type, required_model_type, model_key)
JOIN public.ai_model model ON model.model_key = task.model_key
ON CONFLICT (task_type) DO UPDATE SET
  required_model_type = EXCLUDED.required_model_type,
  model_id = EXCLUDED.model_id,
  update_time = now();

COMMIT;
