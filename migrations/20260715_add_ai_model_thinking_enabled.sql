BEGIN;

-- Per-model thinking switch. NULL keeps provider defaults; true/false is sent to compatible APIs.
ALTER TABLE public.ai_model
  ADD COLUMN IF NOT EXISTS thinking_enabled BOOLEAN DEFAULT NULL;

COMMENT ON COLUMN public.ai_model.thinking_enabled IS
  '是否开启深度思考：NULL 使用供应商默认；true/false 强制传 enable_thinking';

-- GLM-5 defaults to thinking mode on DashScope; disabling keeps resume scoring fast and predictable.
UPDATE public.ai_model
SET thinking_enabled = false,
    update_time = now()
WHERE provider = 'dashscope'
  AND model_key = 'glm-5';

COMMIT;
