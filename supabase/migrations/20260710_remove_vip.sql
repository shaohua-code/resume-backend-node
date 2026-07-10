-- ============================================================
-- 清理 VIP 相关字段与数据
-- 执行说明：删除 user_profile.vip_expire_time、ai_model.vip_only 字段，
--           将历史 VIP 角色用户降级为 USER，清理 membership_plan 的 VIP 套餐
-- ============================================================

-- 1. 将历史 VIP 角色用户降级为 USER（必须在约束变更前执行）
update public.user_profile set role = 'USER' where role = 'VIP';

-- 2. 变更 user_profile.role 约束：移除 VIP 枚举值
alter table public.user_profile
  drop constraint if exists user_profile_role_check;
alter table public.user_profile
  add constraint user_profile_role_check check (role in ('SUPER_ADMIN', 'ADMIN', 'USER'));

-- 3. 删除 user_profile.vip_expire_time 字段
alter table public.user_profile
  drop column if exists vip_expire_time;

-- 4. 删除 ai_model.vip_only 字段
alter table public.ai_model
  drop column if exists vip_only;

-- 5. 清理 membership_plan 中的 VIP 套餐（重命名为普通会员套餐）
update public.membership_plan
  set name = '月度会员', description = '解锁不限次数AI、导出和高级模板'
  where name = '月度VIP';
update public.membership_plan
  set name = '年度会员', description = '一年内解锁全部能力'
  where name = '年度VIP';

-- 6. 清理 system_config.ai_daily_limit 中的 VIP 配置
update public.system_config
  set config_value = '{"USER": 3}'::jsonb
  where config_key = 'ai_daily_limit';
