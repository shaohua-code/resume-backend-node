-- ============================================================
-- AI 简历 - 宝塔 PostgreSQL 完整建库脚本
-- 数据库：ai-resume @ 175.178.62.55
-- 执行环境：宝塔面板 → 数据库 → PostgreSQL → SQL 执行
-- 幂等：可重复执行（IF NOT EXISTS / ON CONFLICT）
-- ============================================================
--
-- 【宝塔操作步骤】
-- 1. 宝塔 → 软件商店 → 安装 PostgreSQL
-- 2. 数据库 → PostgreSQL → 添加数据库 ai-resume / 用户 ai-resume
-- 3. 点管理 → SQL 执行 → 粘贴本文件全文 → 执行
-- 4. 验证：SELECT count(*) FROM information_schema.tables WHERE table_schema='public'; -- 预期 22
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
  account        TEXT,
  email          TEXT UNIQUE,
  password_hash  TEXT,
  password_plain TEXT,
  email_verified BOOLEAN DEFAULT false,
  session_version INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT chk_users_email_or_account CHECK (
    NULLIF(BTRIM(email), '') IS NOT NULL OR NULLIF(BTRIM(account), '') IS NOT NULL
  ),
  CONSTRAINT chk_users_account_lowercase CHECK (account IS NULL OR account = LOWER(account))
);

CREATE TABLE IF NOT EXISTS public.otp_codes (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID REFERENCES public.users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  code       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'login',
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN DEFAULT false,
  attempt_count INT NOT NULL DEFAULT 0 CONSTRAINT chk_otp_attempt_count_nonnegative CHECK (attempt_count >= 0),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_otp_email ON public.otp_codes(email, type, used);

CREATE TABLE IF NOT EXISTS public.refresh_tokens (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  session_version INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON public.refresh_tokens(user_id);

-- ========== 2. 用户资料 ==========

CREATE TABLE IF NOT EXISTS public.user_profile (
  user_id     UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  email       TEXT,
  nickname    TEXT DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('SUPER_ADMIN', 'ADMIN', 'USER')),
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'BANNED')),
  create_time TIMESTAMPTZ DEFAULT now(),
  update_time TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_profile_role ON public.user_profile(role);
CREATE INDEX IF NOT EXISTS idx_user_profile_status ON public.user_profile(status);
CREATE INDEX IF NOT EXISTS idx_user_profile_email ON public.user_profile(email);

-- 兼容已建库环境：认证字段变更必须通过幂等 ALTER 落到线上旧表。
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS account TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS session_version INT NOT NULL DEFAULT 0;
ALTER TABLE public.refresh_tokens ADD COLUMN IF NOT EXISTS session_version INT NOT NULL DEFAULT 0;
ALTER TABLE public.users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE public.user_profile ALTER COLUMN email DROP NOT NULL;
ALTER TABLE public.otp_codes
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.otp_codes
  ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_users_email_or_account'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT chk_users_email_or_account CHECK (
        NULLIF(BTRIM(email), '') IS NOT NULL OR NULLIF(BTRIM(account), '') IS NOT NULL
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_users_account_lowercase'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT chk_users_account_lowercase CHECK (account IS NULL OR account = LOWER(account));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_otp_attempt_count_nonnegative'
      AND conrelid = 'public.otp_codes'::regclass
  ) THEN
    ALTER TABLE public.otp_codes
      ADD CONSTRAINT chk_otp_attempt_count_nonnegative CHECK (attempt_count >= 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_account_lower_unique
  ON public.users (LOWER(account))
  WHERE account IS NOT NULL AND BTRIM(account) <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower_unique
  ON public.users (LOWER(email))
  WHERE email IS NOT NULL AND BTRIM(email) <> '';
CREATE INDEX IF NOT EXISTS idx_otp_user_type
  ON public.otp_codes(user_id, type, used, created_at DESC);

-- 可逆密码已停用；幂等清空历史值，后续所有重置只保存 bcrypt 哈希。
UPDATE public.users SET password_plain = NULL WHERE password_plain IS NOT NULL;

-- ========== 3. 简历 ==========

CREATE TABLE IF NOT EXISTS public.resume (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title       TEXT DEFAULT '未命名简历',
  resume_json TEXT DEFAULT '{}',
  template_id INT  DEFAULT 1,
  score       INT  DEFAULT 0,
  client_request_id TEXT,
  create_time TIMESTAMPTZ DEFAULT now(),
  update_time TIMESTAMPTZ DEFAULT now()
);
-- 生成结果保存使用用户级幂等键；网络响应丢失后的重试返回原记录，不重复创建或替换简历。
ALTER TABLE public.resume ADD COLUMN IF NOT EXISTS client_request_id TEXT;
CREATE INDEX IF NOT EXISTS idx_resume_user_id ON public.resume(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_resume_user_client_request
  ON public.resume(user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

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
  -- NULL=沿用模型配置；true/false=本任务强制开启/关闭深度思考
  thinking_enabled    BOOLEAN DEFAULT NULL,
  create_time         TIMESTAMPTZ DEFAULT now(),
  update_time         TIMESTAMPTZ DEFAULT now()
);

-- 已有库补齐任务级深度思考开关
ALTER TABLE public.ai_task_model
  ADD COLUMN IF NOT EXISTS thinking_enabled BOOLEAN DEFAULT NULL;

-- ========== 6. 系统配置 ==========

CREATE TABLE IF NOT EXISTS public.system_config (
  config_key   TEXT PRIMARY KEY,
  config_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  description  TEXT DEFAULT '',
  update_time  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.announcement (
  id            BIGSERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  -- Markdown 正文；前端用 markdown-it（禁 HTML）渲染
  version_label TEXT DEFAULT '',
  -- 生效时间窗：空表示不限制该边界；仅在窗内且 enabled 时对登录用户弹窗
  start_at      TIMESTAMPTZ,
  end_at        TIMESTAMPTZ,
  enabled       BOOLEAN DEFAULT true,
  create_time   TIMESTAMPTZ DEFAULT now(),
  update_time   TIMESTAMPTZ DEFAULT now()
);

-- 已有库幂等补列（不另建迁移文件）
ALTER TABLE public.announcement ADD COLUMN IF NOT EXISTS version_label TEXT DEFAULT '';
ALTER TABLE public.announcement ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ;
ALTER TABLE public.announcement ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ;

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
  user_id                 UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  balance                 NUMERIC(12, 4) NOT NULL DEFAULT 0,
  total_consumed          NUMERIC(12, 4) NOT NULL DEFAULT 0,
  register_gift_granted_at TIMESTAMPTZ,
  update_time             TIMESTAMPTZ DEFAULT now()
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

-- 免邮箱注册后，注册赠金延迟到首次邮箱验证；时间戳保证并发绑定与旧库重复执行都不会重复发放。
ALTER TABLE public.user_wallet
  ADD COLUMN IF NOT EXISTS register_gift_granted_at TIMESTAMPTZ;
UPDATE public.user_wallet wallet
SET register_gift_granted_at = gift.first_granted_at
FROM (
  SELECT user_id, MIN(create_time) AS first_granted_at
  FROM public.balance_ledger
  WHERE type = 'REGISTER_GIFT' AND amount > 0
  GROUP BY user_id
) gift
WHERE wallet.user_id = gift.user_id
  AND wallet.register_gift_granted_at IS NULL;

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
  ('register_gift_amount', '{"amount": 10}'::jsonb, '随机账号首次验证邮箱赠送额度上限（元）'),
  ('super_admin_total_quota', '{"amount": 1000000}'::jsonb, '超级管理员初始总额度池（元）'),
  ('recharge_email_admin_notify', '{"subject":"【AI简历】用户提交了充值凭证","html":"","text":""}'::jsonb, '用户提交充值凭证后通知管理员的邮件模板'),
  ('recharge_email_user_confirm', '{"subject":"【AI简历】充值已到账","html":"","text":""}'::jsonb, '管理员确认充值后通知用户的邮件模板'),
  -- 超级管理员开启后，普通用户才可在 /user 按任务选择模型 / 编辑提示词指令段
  ('user_ai_model_customization', '{"enabled": false}'::jsonb, '是否允许用户自定义各 AI 任务模型（仅选择，不配置密钥）'),
  ('user_ai_prompt_customization', '{"enabled": false}'::jsonb, '是否允许用户自定义各 AI 任务业务提示词（不含输出格式）')
ON CONFLICT (config_key) DO NOTHING;

-- ========== 用户级 AI 任务模型覆盖（隔离；无覆盖则用全局 ai_task_model） ==========
CREATE TABLE IF NOT EXISTS public.user_ai_task_model (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  task_type   TEXT NOT NULL,
  model_id    BIGINT NOT NULL REFERENCES public.ai_model(id) ON DELETE RESTRICT,
  create_time TIMESTAMPTZ DEFAULT now(),
  update_time TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, task_type)
);
CREATE INDEX IF NOT EXISTS idx_user_ai_task_model_user ON public.user_ai_task_model(user_id);

-- ========== 管理员默认 / 用户覆盖：仅业务指令段（输出 Schema 永不入库） ==========
CREATE TABLE IF NOT EXISTS public.ai_task_prompt (
  id          BIGSERIAL PRIMARY KEY,
  task_type   TEXT UNIQUE NOT NULL,
  instruction TEXT NOT NULL DEFAULT '',
  create_time TIMESTAMPTZ DEFAULT now(),
  update_time TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_ai_task_prompt (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  task_type   TEXT NOT NULL,
  instruction TEXT NOT NULL DEFAULT '',
  create_time TIMESTAMPTZ DEFAULT now(),
  update_time TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, task_type)
);
CREATE INDEX IF NOT EXISTS idx_user_ai_task_prompt_user ON public.user_ai_task_prompt(user_id);

-- 管理员默认业务提示词（与 services/ai/ai.prompts.js CODE_DEFAULT_INSTRUCTIONS 对齐；可重复执行）
-- 完整独立脚本见 database/seed_ai_task_prompt.sql
INSERT INTO public.ai_task_prompt (task_type, instruction, create_time, update_time)
VALUES
  (
    'resume_generate',
    $prompt$根据用户填写信息生成完整、可投递的简历。
1. 有较完整经历时：保留真实姓名、联系方式、公司、学校等事实，逐项优化评价、技能与各段经历，确保相对原文有实质提升。
2. 仅有姓名+意向岗位等极少信息时：围绕岗位生成示意性个人评价、技能、公司经历与项目，并提示「由于提供信息过少，已基于意向岗位生成若干示意性基本信息，请按真实经历修改后再投递」。
3. 禁止输出几乎空白或与输入几乎无差异的结果。$prompt$,
    now(), now()
  ),
  (
    'resume_extract',
    $prompt$把输入原文中明确出现的内容忠实整理为结构化简历信息。
1. 只做信息抽取与字段归位，禁止润色、补写、推断或按岗位优化。
2. 原文未出现的公司、日期、技能、成果一律留空。
3. 实习/工作中明确出现的公司名必须写入 company，不得整段塞进 description。$prompt$,
    now(), now()
  ),
  (
    'project_optimize',
    $prompt$优化单条项目经历，必须相对原文有实质改写并贴合目标岗位。
1. 突出本人角色、关键动作、方法工具与交付物。
2. 禁止只换同义词；有明确结果才写结果，不虚构量化业绩。$prompt$,
    now(), now()
  ),
  (
    'summary_optimize',
    $prompt$重写个人评价，形成清晰、可面试的岗位能力画像。
1. 必须实质改写，禁止同义反复。
2. 回答是谁、核心能力、为何匹配、差异化优势。$prompt$,
    now(), now()
  ),
  (
    'skills_optimize',
    $prompt$整理并优化技能列表。
1. 统一标准名、去重、按岗位相关度重排，禁止原样复制。
2. 可补岗位常见基础硬技能；软技能不作标签。$prompt$,
    now(), now()
  ),
  (
    'internship_optimize',
    $prompt$优化单条实习经历，必须实质改写。
1. 写清参与范围、动作、工具与交付物。
2. 不编造业务结果或量化提升。$prompt$,
    now(), now()
  ),
  (
    'work_experience_optimize',
    $prompt$优化单条工作经历，必须实质改写。
1. 升级为清晰的任务、个人动作、方法工具与交付表达。
2. 有明确结果才写结果；保持贡献程度准确。$prompt$,
    now(), now()
  ),
  (
    'jd_match',
    $prompt$分析简历与岗位要求的匹配度。
1. 区分直接匹配、可迁移匹配与简历未体现。
2. 缺口只建议补充证据，不得写成已具备；本任务不改写简历。$prompt$,
    now(), now()
  ),
  (
    'score',
    $prompt$按通用评分口径为简历打分。
1. 综合完整度、技能相关性、经历证据、结构与文本规范。
2. 不因敏感信息缺失或关键词堆砌加减分。$prompt$,
    now(), now()
  ),
  (
    'pdf_optimize',
    $prompt$基于上传简历原文优化完整简历。
1. 逐条优化已有模块，确保优化前后有实质差异。
2. 信息过少时可基于岗位生成示意内容并明确提示用户修改。$prompt$,
    now(), now()
  ),
  (
    'jd_resume_optimize',
    $prompt$按岗位JD优化完整简历，适当重塑为岗位所需样子。
1. 重写评价、技能与每一条经历；保留真实姓名、联系方式、教育与已有公司名。
2. 信息过少时基于岗位生成示意内容，并在优化说明首条提示用户按真实经历修改。
3. 禁止优化后几乎无变化。$prompt$,
    now(), now()
  ),
  (
    'pdf_jd_optimize',
    $prompt$结合简历原文与岗位JD优化完整简历。
1. 保留原文事实专有名词，按岗位对齐表达并逐条优化经历。
2. 信息过少时允许示意补全并披露；禁止无实质改动。$prompt$,
    now(), now()
  ),
  (
    'jd_image_extract',
    $prompt$忠实转录图片中的岗位招聘信息为纯文本。
1. 不润色、不补全、不推断。
2. 看不清处如实标注，不得猜测。$prompt$,
    now(), now()
  )
ON CONFLICT (task_type) DO UPDATE SET
  instruction = EXCLUDED.instruction,
  update_time = now();

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
  -- PDF 与文字识别共用纯提取任务，不复用生成或 PDF 优化任务。
  ('resume_extract', 'text', 'deepseek-v4-flash'),
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
