-- ============================================================
-- 运维脚本：清除所有用户及关联数据（不可逆，慎用）
-- 执行：psql -h 127.0.0.1 -U ai_resume -d ai_resume -f database/ops/clear_all_users.sql
-- 说明：清空后需重新注册账号并执行 §11 超管 SQL
-- ============================================================

TRUNCATE TABLE
  public.balance_ledger,
  public.ai_call_record,
  public.export_record,
  public.resume,
  public.order_record,
  public.user_feedback,
  public.admin_action_log,
  public.admin_user_relation,
  public.invite_link,
  public.user_wallet,
  public.refresh_tokens,
  public.otp_codes,
  public.user_profile,
  public.users
RESTART IDENTITY CASCADE;

-- 访问日志与用户无强关联，一并清空
TRUNCATE TABLE public.visit_log RESTART IDENTITY;
