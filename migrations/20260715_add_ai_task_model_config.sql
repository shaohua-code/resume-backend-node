BEGIN;

-- 模型表只保存调用元数据和密钥环境变量名，绝不保存 API Key 明文。

ALTER TABLE public.ai_model
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'deepseek',
  ADD COLUMN IF NOT EXISTS model_type TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS api_url TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS api_key_env TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS cached_input_price_per_million NUMERIC(10, 4) DEFAULT 0;

UPDATE public.ai_model
SET
  name = 'DeepSeek V4 Flash',
  provider = 'deepseek',
  model_type = 'text',
  api_key_env = 'DEEPSEEK_API_KEY',
  input_price_per_million = 1.0,
  cached_input_price_per_million = 0.02,
  output_price_per_million = 2.0,
  update_time = now()
WHERE model_key = 'deepseek-v4-flash';

UPDATE public.ai_model
SET
  name = 'DeepSeek Chat（兼容别名，即将下线）',
  provider = 'deepseek',
  model_type = 'text',
  api_key_env = 'DEEPSEEK_API_KEY',
  input_price_per_million = 1.0,
  cached_input_price_per_million = 0.02,
  output_price_per_million = 2.0,
  enabled = false,
  update_time = now()
WHERE model_key = 'deepseek-chat';

INSERT INTO public.ai_model (
  name, model_key, task_type, provider, model_type, api_key_env,
  input_price_per_million, cached_input_price_per_million,
  output_price_per_million, enabled
)
VALUES (
  'Qwen3.6 Flash 视觉模型', 'qwen3.6-flash', 'all', 'dashscope', 'vision',
  'DASHSCOPE_API_KEY', 1.2, 0.24, 7.2, true
)
ON CONFLICT (model_key) DO UPDATE SET
  name = EXCLUDED.name,
  provider = EXCLUDED.provider,
  model_type = EXCLUDED.model_type,
  api_key_env = EXCLUDED.api_key_env,
  input_price_per_million = EXCLUDED.input_price_per_million,
  cached_input_price_per_million = EXCLUDED.cached_input_price_per_million,
  output_price_per_million = EXCLUDED.output_price_per_million,
  enabled = true,
  update_time = now();

CREATE TABLE IF NOT EXISTS public.ai_task_model (
  id                  BIGSERIAL PRIMARY KEY,
  task_type           TEXT UNIQUE NOT NULL,
  required_model_type TEXT NOT NULL DEFAULT 'text',
  model_id            BIGINT NOT NULL REFERENCES public.ai_model(id) ON DELETE RESTRICT,
  create_time         TIMESTAMPTZ DEFAULT now(),
  update_time         TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE public.ai_task_model IS 'AI 任务到模型的一对一运行时映射';
COMMENT ON COLUMN public.ai_model.model_type IS '模型能力类型：text、vision，后续可扩展其他小写标识';
COMMENT ON COLUMN public.ai_model.api_key_env IS '服务端 API Key 环境变量名，不保存密钥明文';
COMMENT ON COLUMN public.ai_model.cached_input_price_per_million IS '每百万缓存命中输入 Token 单价（人民币）';

INSERT INTO public.ai_task_model (task_type, required_model_type, model_id)
SELECT task.task_type, task.required_model_type, model.id
FROM (VALUES
  ('resume_generate', 'text', 'deepseek-v4-flash'),
  ('project_optimize', 'text', 'deepseek-v4-flash'),
  ('summary_optimize', 'text', 'deepseek-v4-flash'),
  ('skills_optimize', 'text', 'deepseek-v4-flash'),
  ('internship_optimize', 'text', 'deepseek-v4-flash'),
  ('work_experience_optimize', 'text', 'deepseek-v4-flash'),
  ('jd_match', 'text', 'deepseek-v4-flash'),
  ('score', 'text', 'deepseek-v4-flash'),
  ('pdf_optimize', 'text', 'deepseek-v4-flash'),
  ('jd_resume_optimize', 'text', 'deepseek-v4-flash'),
  ('pdf_jd_optimize', 'text', 'deepseek-v4-flash'),
  ('jd_image_extract', 'vision', 'qwen3.6-flash')
) AS task(task_type, required_model_type, model_key)
JOIN public.ai_model model ON model.model_key = task.model_key
ON CONFLICT (task_type) DO NOTHING;

COMMIT;
