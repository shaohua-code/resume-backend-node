-- 将尚未被管理员自定义的充值邮件默认主题从旧品牌名迁移为“AI简历”。
BEGIN;

-- 仅匹配旧默认值，避免覆盖管理员已经编辑过的通知主题。
UPDATE public.system_config
SET config_value = jsonb_set(config_value, '{subject}', to_jsonb('【AI简历】用户提交了充值凭证'::text)),
    update_time = now()
WHERE config_key = 'recharge_email_admin_notify'
  AND config_value->>'subject' = '【AI简历助手】用户提交了充值凭证';

-- 用户到账通知同样只替换旧默认主题，保留其他模板字段和自定义内容。
UPDATE public.system_config
SET config_value = jsonb_set(config_value, '{subject}', to_jsonb('【AI简历】充值已到账'::text)),
    update_time = now()
WHERE config_key = 'recharge_email_user_confirm'
  AND config_value->>'subject' = '【AI简历助手】充值已到账';

-- 两项默认主题更新必须作为同一事务提交，防止部署时只完成一半。
COMMIT;
