-- ============================================================
-- 安全加固迁移：清除数据库中的明文密码
-- 执行日期：2026-07-13
-- 说明：将 password_plain 字段清空，后续使用 AES-256-GCM 加密存储
-- ============================================================

-- 1. 备份当前数据（可选，建议先执行）
-- CREATE TABLE users_password_backup AS
-- SELECT id, email, password_plain, updated_at
-- FROM public.users
-- WHERE password_plain IS NOT NULL AND password_plain != '';

-- 2. 清除所有明文密码数据
UPDATE public.users
SET
    password_plain = NULL,
    updated_at = now()
WHERE password_plain IS NOT NULL AND password_plain != '';

-- 3. 验证清理结果
SELECT
    COUNT(*) AS total_users,
    SUM(CASE WHEN password_plain IS NULL OR password_plain = '' THEN 1 ELSE 0 END) AS cleared_users,
    SUM(CASE WHEN password_plain IS NOT NULL AND password_plain != '' THEN 1 ELSE 0 END) AS remaining_plaintext
FROM public.users;

-- 注意：此迁移不可逆！请确保已备份重要数据后再执行。
-- 迁移完成后，新注册/登录的用户密码将以 AES-256-GCM 加密形式存储。
