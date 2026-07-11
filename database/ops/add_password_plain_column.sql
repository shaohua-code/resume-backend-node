-- ============================================================
-- 迁移：users 表增加 password_plain 字段（记录最近一次登录/设置的明文密码）
-- 执行：psql -h 127.0.0.1 -U ai_resume -d ai_resume -f database/ops/add_password_plain_column.sql
-- ============================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS password_plain TEXT;

COMMENT ON COLUMN public.users.password_plain IS '最近一次登录或设置密码时的明文（仅内部运维使用，注意安全）';
