-- 增量迁移：用户充值凭证申请表 + 邮件模板种子
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

INSERT INTO public.system_config (config_key, config_value, description)
VALUES
  ('recharge_email_admin_notify', '{"subject":"【AI简历助手】用户提交了充值凭证","html":"","text":""}'::jsonb, '用户提交充值凭证后通知管理员的邮件模板'),
  ('recharge_email_user_confirm', '{"subject":"【AI简历助手】充值已到账","html":"","text":""}'::jsonb, '管理员确认充值后通知用户的邮件模板')
ON CONFLICT (config_key) DO NOTHING;
