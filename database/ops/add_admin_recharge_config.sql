-- 增量迁移：管理员充值二维码配置表
CREATE TABLE IF NOT EXISTS public.admin_recharge_config (
  admin_id           UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  payment_qrcode_url TEXT DEFAULT '',
  contact_qrcode_url TEXT DEFAULT '',
  payment_platform   TEXT DEFAULT '',
  contact_platform   TEXT DEFAULT '',
  update_time        TIMESTAMPTZ DEFAULT now()
);
