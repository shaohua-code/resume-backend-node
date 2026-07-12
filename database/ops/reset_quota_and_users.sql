-- ============================================================
-- 运维脚本：重置所有用户额度与用量记录（已废弃，请使用 init_all_user_quota.sql）
-- 执行：psql -h 127.0.0.1 -U ai_resume -d ai_resume -f database/ops/init_all_user_quota.sql
-- ============================================================

\i init_all_user_quota.sql
