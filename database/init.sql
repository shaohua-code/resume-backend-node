-- ============================================================
-- AI 简历助手 - 宝塔 PostgreSQL 完整建库脚本
-- 数据库：ai-resume @ 175.178.62.55
-- 执行环境：宝塔面板 → 数据库 → PostgreSQL → SQL 执行
-- 幂等：可重复执行（IF NOT EXISTS / ON CONFLICT）
-- ============================================================
--
-- 【宝塔操作步骤】
-- 1. 宝塔 → 软件商店 → 安装 PostgreSQL
-- 2. 数据库 → PostgreSQL → 添加数据库 ai-resume / 用户 ai-resume
-- 3. 点管理 → SQL 执行 → 粘贴本文件全文 → 执行
-- 4. 验证：SELECT count(*) FROM information_schema.tables WHERE table_schema='public'; -- 预期 21
--
-- 【后端 .env】
-- DATABASE_URL=postgresql://ai-resume:密码@175.178.62.55:5432/ai-resume
--
-- 【创建超级管理员】注册账号后执行：
-- UPDATE public.user_profile SET role='SUPER_ADMIN' WHERE email='你的邮箱';
-- INSERT INTO public.user_wallet (user_id, balance, total_consumed, update_time)
-- SELECT user_id, 1000000, 0, now() FROM public.user_profile WHERE email='你的邮箱'
-- ON CONFLICT (user_id) DO UPDATE SET balance = 1000000, update_time = now();
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ========== 1. 认证表 ==========

CREATE TABLE IF NOT EXISTS public.users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT,
  password_plain TEXT,
  email_verified BOOLEAN DEFAULT false,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.otp_codes (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  code       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'login',
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_otp_email ON public.otp_codes(email, type, used);

CREATE TABLE IF NOT EXISTS public.refresh_tokens (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON public.refresh_tokens(user_id);

-- ========== 2. 用户资料 ==========

CREATE TABLE IF NOT EXISTS public.user_profile (
  user_id     UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  nickname    TEXT DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('SUPER_ADMIN', 'ADMIN', 'USER')),
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BANNED')),
  create_time TIMESTAMPTZ DEFAULT now(),
  update_time TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_profile_role ON public.user_profile(role);
CREATE INDEX IF NOT EXISTS idx_user_profile_status ON public.user_profile(status);
CREATE INDEX IF NOT EXISTS idx_user_profile_email ON public.user_profile(email);

-- ========== 3. 简历 ==========

CREATE TABLE IF NOT EXISTS public.resume (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title       TEXT DEFAULT '未命名简历',
  resume_json TEXT DEFAULT '{}',
  template_id INT  DEFAULT 1,
  score       INT  DEFAULT 0,
  create_time TIMESTAMPTZ DEFAULT now(),
  update_time TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_resume_user_id ON public.resume(user_id);

CREATE TABLE IF NOT EXISTS public.export_record (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  resume_id   BIGINT NOT NULL REFERENCES public.resume(id) ON DELETE CASCADE,
  create_time TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_export_user_id ON public.export_record(user_id);

-- ========== 4. 会员与订单 ==========

CREATE TABLE IF NOT EXISTS public.membership_plan (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  price         NUMERIC(10, 2) NOT NULL DEFAULT 0,
  duration_days INT NOT NULL DEFAULT 30,
  description   TEXT DEFAULT '',
  enabled       BOOLEAN DEFAULT true,
  create_time   TIMESTAMPTZ DEFAULT now(),
  update_time   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.order_record (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES public.users(id) ON DELETE SET NULL,
  plan_id     BIGINT REFERENCES public.membership_plan(id) ON DELETE SET NULL,
  order_no    TEXT UNIQUE NOT NULL,
  amount      NUMERIC(10, 2) NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'CANCELLED', 'REFUNDED')),
  pay_time    TIMESTAMPTZ,
  create_time TIMESTAMPTZ DEFAULT now(),
  update_time TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_record_user_id ON public.order_record(user_id);
CREATE INDEX IF NOT EXISTS idx_order_record_status ON public.order_record(status);

-- ========== 5. AI ==========

CREATE TABLE IF NOT EXISTS public.ai_call_record (
  id                BIGSERIAL PRIMARY KEY,
  user_id           UUID REFERENCES public.users(id) ON DELETE SET NULL,
  task_type         TEXT NOT NULL,
  model             TEXT DEFAULT '',
  prompt_tokens     INT DEFAULT 0,
  completion_tokens INT DEFAULT 0,
  total_tokens      INT DEFAULT 0,
  cost              NUMERIC(10, 6) DEFAULT 0,
  success           BOOLEAN DEFAULT true,
  error_message     TEXT DEFAULT '',
  create_time       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_call_record_user_task_time ON public.ai_call_record(user_id, task_type, create_time);

CREATE TABLE IF NOT EXISTS public.ai_model (
  id                       BIGSERIAL PRIMARY KEY,
  name                     TEXT NOT NULL,
  model_key                TEXT UNIQUE NOT NULL,
  task_type                TEXT DEFAULT 'all', -- 兼容旧数据；任务分配改由 ai_task_model 维护
  provider                 TEXT NOT NULL DEFAULT 'deepseek',
  model_type               TEXT NOT NULL DEFAULT 'text',
  api_url                  TEXT DEFAULT '',
  api_key_env              TEXT DEFAULT '',
  input_price_per_million  NUMERIC(10, 4) DEFAULT 0,
  cached_input_price_per_million NUMERIC(10, 4) DEFAULT 0,
  output_price_per_million NUMERIC(10, 4) DEFAULT 0,
  official_input_price_per_million NUMERIC(10, 4) DEFAULT 0,
  official_cached_input_price_per_million NUMERIC(10, 4) DEFAULT 0,
  official_output_price_per_million NUMERIC(10, 4) DEFAULT 0,
  thinking_enabled         BOOLEAN DEFAULT NULL, -- NULL 使用供应商默认；true/false 强制传 enable_thinking
  enabled                  BOOLEAN DEFAULT true,
  create_time              TIMESTAMPTZ DEFAULT now(),
  update_time              TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_task_model (
  id                  BIGSERIAL PRIMARY KEY,
  task_type           TEXT UNIQUE NOT NULL,
  required_model_type TEXT NOT NULL DEFAULT 'text',
  model_id            BIGINT NOT NULL REFERENCES public.ai_model(id) ON DELETE RESTRICT,
  create_time         TIMESTAMPTZ DEFAULT now(),
  update_time         TIMESTAMPTZ DEFAULT now()
);

-- ========== 6. 系统配置 ==========

CREATE TABLE IF NOT EXISTS public.system_config (
  config_key   TEXT PRIMARY KEY,
  config_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  description  TEXT DEFAULT '',
  update_time  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.announcement (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  enabled     BOOLEAN DEFAULT true,
  create_time TIMESTAMPTZ DEFAULT now(),
  update_time TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_action_log (
  id            BIGSERIAL PRIMARY KEY,
  admin_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  target_type   TEXT DEFAULT '',
  target_id     TEXT DEFAULT '',
  create_time   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_action_log_admin_time ON public.admin_action_log(admin_user_id, create_time);

-- ========== 7. 反馈 ==========

CREATE TABLE IF NOT EXISTS public.user_feedback (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID REFERENCES public.users(id) ON DELETE SET NULL,
  content_html TEXT NOT NULL DEFAULT '',
  content_md   TEXT NOT NULL DEFAULT '',
  create_time  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_feedback_user_id ON public.user_feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_user_feedback_create_time ON public.user_feedback(create_time DESC);

-- ========== 8. 钱包 ==========

CREATE TABLE IF NOT EXISTS public.user_wallet (
  user_id        UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  balance        NUMERIC(12, 4) NOT NULL DEFAULT 0,
  total_consumed NUMERIC(12, 4) NOT NULL DEFAULT 0,
  update_time    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.balance_ledger (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  amount        NUMERIC(12, 4) NOT NULL,
  balance_after NUMERIC(12, 4) NOT NULL,
  remark        TEXT DEFAULT '',
  operator_id   UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ai_call_id    BIGINT REFERENCES public.ai_call_record(id) ON DELETE SET NULL,
  paid_amount   NUMERIC(12, 4) DEFAULT 0,
  create_time   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_balance_ledger_user_time ON public.balance_ledger(user_id, create_time DESC);
CREATE INDEX IF NOT EXISTS idx_balance_ledger_type ON public.balance_ledger(type);

COMMENT ON COLUMN public.balance_ledger.paid_amount IS '实付金额（ADMIN_GRANT 类型有值）';

-- ========== 9. 管理员归属 ==========

CREATE TABLE IF NOT EXISTS public.admin_user_relation (
  id          BIGSERIAL PRIMARY KEY,
  admin_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  bind_type   TEXT NOT NULL CHECK (bind_type IN ('INVITE_LINK', 'EMAIL_CLAIM', 'LEGACY_MIGRATE')),
  create_time TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS idx_admin_user_relation_admin ON public.admin_user_relation(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_user_relation_user ON public.admin_user_relation(user_id);

CREATE TABLE IF NOT EXISTS public.invite_link (
  id          BIGSERIAL PRIMARY KEY,
  admin_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE,
  status      TEXT DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  expire_time TIMESTAMPTZ,
  used_count  INT DEFAULT 0,
  create_time TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invite_link_admin ON public.invite_link(admin_id);
CREATE INDEX IF NOT EXISTS idx_invite_link_code ON public.invite_link(code);

-- 管理员充值二维码配置（按 admin_id 隔离）
CREATE TABLE IF NOT EXISTS public.admin_recharge_config (
  admin_id           UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  payment_qrcode_url TEXT DEFAULT '',
  contact_qrcode_url TEXT DEFAULT '',
  payment_platform   TEXT DEFAULT '',
  contact_platform   TEXT DEFAULT '',
  update_time        TIMESTAMPTZ DEFAULT now()
);

-- 用户充值凭证申请（管理员审核入账）
CREATE TABLE IF NOT EXISTS public.recharge_request (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  admin_id      UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  proof_url     TEXT NOT NULL DEFAULT '',
  paid_amount   NUMERIC(12, 4) NOT NULL,
  grant_amount  NUMERIC(12, 4),
  status        TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING', 'APPROVED')),
  operator_id   UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ledger_id     BIGINT REFERENCES public.balance_ledger(id) ON DELETE SET NULL,
  create_time   TIMESTAMPTZ DEFAULT now(),
  update_time   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recharge_request_admin ON public.recharge_request(admin_id, create_time DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_request_user ON public.recharge_request(user_id, create_time DESC);

-- ========== 10. 访客 ==========

CREATE TABLE IF NOT EXISTS public.visit_log (
  id               BIGSERIAL PRIMARY KEY,
  user_email       TEXT DEFAULT '',
  ip_address       TEXT DEFAULT '',
  province         TEXT DEFAULT '',
  city             TEXT DEFAULT '',
  browser          TEXT DEFAULT '',
  os               TEXT DEFAULT '',
  device_type      TEXT DEFAULT '',
  device_brand     TEXT DEFAULT '',
  visit_source     TEXT DEFAULT '',
  landing_path     TEXT DEFAULT '',
  duration_seconds INT DEFAULT 0,
  visit_time       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_visit_log_time ON public.visit_log(visit_time DESC);

-- ========== 11. 种子数据 ==========

INSERT INTO public.membership_plan (name, price, duration_days, description, enabled)
SELECT '月度会员', 19.90, 30, '解锁不限次数AI、导出和高级模板', true
WHERE NOT EXISTS (SELECT 1 FROM public.membership_plan WHERE name = '月度会员');

INSERT INTO public.membership_plan (name, price, duration_days, description, enabled)
SELECT '年度会员', 199.00, 365, '一年内解锁全部能力', true
WHERE NOT EXISTS (SELECT 1 FROM public.membership_plan WHERE name = '年度会员');

INSERT INTO public.system_config (config_key, config_value, description)
VALUES
  ('ai_daily_limit', '{"USER": 3}'::jsonb, '普通用户每日每类AI调用次数'),
  ('register_gift_amount', '{"amount": 10}'::jsonb, '新用户注册赠送额度（元）'),
  ('super_admin_total_quota', '{"amount": 1000000}'::jsonb, '超级管理员初始总额度池（元）'),
  ('recharge_email_admin_notify', '{"subject":"【AI简历助手】用户提交了充值凭证","html":"","text":""}'::jsonb, '用户提交充值凭证后通知管理员的邮件模板'),
  ('recharge_email_user_confirm', '{"subject":"【AI简历助手】充值已到账","html":"","text":""}'::jsonb, '管理员确认充值后通知用户的邮件模板')
ON CONFLICT (config_key) DO NOTHING;

INSERT INTO public.ai_model (
  name, model_key, task_type, provider, model_type, api_key_env,
  input_price_per_million, cached_input_price_per_million, output_price_per_million,
  official_input_price_per_million, official_cached_input_price_per_million, official_output_price_per_million,
  thinking_enabled, enabled
)
VALUES
  ('DeepSeek V4 Flash', 'deepseek-v4-flash', 'all', 'deepseek', 'text', 'DEEPSEEK_API_KEY', 1.0, 0.1, 2.0, 1.0, 0.1, 2.0, NULL, true),
  ('DeepSeek Chat (legacy alias)', 'deepseek-chat', 'all', 'deepseek', 'text', 'DEEPSEEK_API_KEY', 1.0, 0.1, 2.0, 1.0, 0.1, 2.0, NULL, false),
  ('Qwen3.6 Flash Vision', 'qwen3.6-flash', 'all', 'dashscope', 'vision', 'DASHSCOPE_API_KEY', 1.2, 0.12, 7.2, 1.2, 0.12, 7.2, false, true)
ON CONFLICT (model_key) DO UPDATE SET
  input_price_per_million = EXCLUDED.input_price_per_million,
  cached_input_price_per_million = EXCLUDED.cached_input_price_per_million,
  output_price_per_million = EXCLUDED.output_price_per_million,
  official_input_price_per_million = EXCLUDED.official_input_price_per_million,
  official_cached_input_price_per_million = EXCLUDED.official_cached_input_price_per_million,
  official_output_price_per_million = EXCLUDED.official_output_price_per_million,
  thinking_enabled = EXCLUDED.thinking_enabled,
  enabled = EXCLUDED.enabled,
  update_time = now();

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
