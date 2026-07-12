-- 增量迁移：充值二维码增加平台字段（付款码与管理员码可分别配置）
ALTER TABLE public.admin_recharge_config
  ADD COLUMN IF NOT EXISTS payment_platform TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_platform TEXT DEFAULT '';
