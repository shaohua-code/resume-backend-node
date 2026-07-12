# 数据库表中文对照

项目共 **19 张表**，建表脚本见 [`init.sql`](init.sql)。

验证表数量：

```sql
SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';
-- 预期：19
```

---

## 1. 认证模块

### users — 用户账号表

| 项 | 说明 |
|---|---|
| 主键 | `id` (UUID) |
| 核心字段 | `email`（唯一）、`password_hash`、`password_plain`（最近登录/设置的明文）、`email_verified`、`created_at`、`updated_at` |
| 关联 | `user_profile.user_id` → `users.id`（CASCADE） |
| 代码路径 | `services/auth/auth.service.js`（直连 `lib/db.js`） |

### otp_codes — 验证码表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `email`、`code`、`type`（login/register/reset）、`expires_at`、`used` |
| 关联 | 无 FK，按 email 关联用户 |
| 代码路径 | `services/auth/auth.service.js` |

### refresh_tokens — 刷新令牌表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `user_id`、`token_hash`、`expires_at` |
| 关联 | `user_id` → `users.id`（CASCADE） |
| 代码路径 | `lib/jwt.js` |

---

## 2. 用户资料

### user_profile — 用户资料表

| 项 | 说明 |
|---|---|
| 主键 | `user_id` (UUID) |
| 核心字段 | `email`、`nickname`、`role`（SUPER_ADMIN/ADMIN/USER）、`status`（ACTIVE/BANNED） |
| 关联 | `user_id` → `users.id`（CASCADE） |
| 代码路径 | `repositories/user.repository.js`、`services/user_profile_service.js` |

---

## 3. 简历

### resume — 简历表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `user_id`、`title`、`resume_json`、`template_id`、`score` |
| 关联 | `user_id` → `users.id`（CASCADE） |
| 代码路径 | `repositories/resume.repository.js`、`services/resume/resume.service.js` |

### export_record — 导出记录表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `user_id`、`resume_id`、`create_time` |
| 关联 | `user_id` → `users.id`；`resume_id` → `resume.id`（CASCADE） |
| 代码路径 | `services/resume/resume.service.js` |

---

## 4. 会员与订单

### membership_plan — 会员套餐表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `name`、`price`、`duration_days`、`description`、`enabled` |
| 关联 | 被 `order_record.plan_id` 引用 |
| 代码路径 | `services/admin/admin.crud.service.js` |

### order_record — 订单表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `user_id`、`plan_id`、`order_no`、`amount`、`status`、`pay_time` |
| 关联 | `user_id` → `users.id`（SET NULL）；`plan_id` → `membership_plan.id` |
| 代码路径 | `repositories/order.repository.js` |

---

## 5. AI

### ai_call_record — AI 调用记录表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `user_id`、`task_type`、`model`、`prompt_tokens`、`completion_tokens`、`cost`、`success` |
| 关联 | `user_id` → `users.id`（SET NULL）；被 `balance_ledger.ai_call_id` 引用 |
| 代码路径 | `repositories/aiCall.repository.js`、`services/ai/ai.quota.service.js` |

### ai_model — AI 模型配置表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `name`、`model_key`（唯一）、`task_type`、输入/输出单价、`enabled` |
| 关联 | 无 FK，按 `model_key` 被计费逻辑引用 |
| 代码路径 | `utils/ai_cost.js`、`services/admin/admin.crud.service.js` |

---

## 6. 系统配置

### system_config — 系统配置表

| 项 | 说明 |
|---|---|
| 主键 | `config_key` (TEXT) |
| 核心字段 | `config_value`（JSONB）、`description` |
| 常用键 | `register_gift_amount`、`super_admin_total_quota`、`ai_daily_limit` |
| 代码路径 | `repositories/config.repository.js` |

### announcement — 公告表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `title`、`content`、`enabled` |
| 代码路径 | `services/admin/admin.crud.service.js`、`services/admin/admin.dashboard.service.js` |

### admin_action_log — 管理员操作日志表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `admin_user_id`、`action`、`target_type`、`target_id` |
| 关联 | `admin_user_id` → `users.id`（SET NULL） |
| 代码路径 | `services/admin/admin.common.service.js` |

---

## 7. 反馈

### user_feedback — 用户反馈表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `user_id`、`content_html`、`content_md` |
| 关联 | `user_id` → `users.id`（SET NULL） |
| 代码路径 | `repositories/feedback.repository.js`、`routers/feedback.js` |

---

## 8. 钱包

### user_wallet — 用户钱包表

| 项 | 说明 |
|---|---|
| 主键 | `user_id` (UUID) |
| 核心字段 | `balance`、`total_consumed` |
| 关联 | `user_id` → `users.id`（CASCADE） |
| 代码路径 | `repositories/wallet.repository.js`、`services/wallet/wallet.service.js` |

### balance_ledger — 余额流水表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `user_id`、`type`、`amount`、`balance_after`、`remark`、`operator_id`、`ai_call_id`、`paid_amount` |
| 流水类型 | `REGISTER_GIFT`、`AI_CONSUME`、`ADMIN_GRANT`、`ADMIN_DEDUCT`、`REFUND` |
| 关联 | `user_id` → `users.id`；`ai_call_id` → `ai_call_record.id` |
| 代码路径 | `repositories/wallet.repository.js`、`services/wallet/wallet.service.js` |

---

## 9. 管理员归属

### admin_user_relation — 管理员用户归属表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `admin_id`、`user_id`、`bind_type`（INVITE_LINK/EMAIL_CLAIM/LEGACY_MIGRATE） |
| 约束 | `user_id` 唯一（每用户仅归属一个管理员） |
| 代码路径 | `services/admin/admin.invite.service.js`、`services/admin/admin.user.service.js` |

### invite_link — 邀请链接表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `admin_id`、`code`（唯一）、`status`、`expire_time`、`used_count` |
| 关联 | `admin_id` → `users.id`（CASCADE） |
| 代码路径 | `services/admin/admin.invite.service.js` |

---

## 10. 访客

### visit_log — 访问日志表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `user_email`、`ip_address`、`province`、`city`、`browser`、`os`、`device_type`、`landing_path`、`duration_seconds`、`visit_time` |
| 关联 | 无 FK |
| 代码路径 | `repositories/visit.repository.js` |

---

## 运维脚本

| 脚本 | 用途 |
|---|---|
| [`ops/init_all_user_quota.sql`](ops/init_all_user_quota.sql) | 初始化所有 USER 余额与超管额度池（幂等） |
| [`ops/clear_all_users.sql`](ops/clear_all_users.sql) | 清除所有用户及关联数据（不可逆） |
| [`ops/reset_quota_and_users.sql`](ops/reset_quota_and_users.sql) | 旧版额度重置（已迁移至 init_all_user_quota.sql） |

---

## 表名速查

| 英文表名 | 中文名称 | 简要说明 |
|---------|---------|---------|
| `users` | 用户账号表 | 邮箱、密码哈希、最近明文密码 |
| `otp_codes` | 验证码表 | 登录/重置密码 OTP |
| `refresh_tokens` | 刷新令牌表 | JWT refresh token |
| `user_profile` | 用户资料表 | 昵称、角色、封禁状态 |
| `resume` | 简历表 | 简历 JSON 数据 |
| `export_record` | 导出记录表 | PDF 导出审计 |
| `membership_plan` | 会员套餐表 | 套餐配置（已弱化 VIP） |
| `order_record` | 订单表 | 支付订单 |
| `ai_call_record` | AI 调用记录表 | Token 用量与费用 |
| `ai_model` | AI 模型配置表 | 模型单价 |
| `system_config` | 系统配置表 | 注册赠送额、超管额度池等 |
| `announcement` | 公告表 | 前台公告 |
| `admin_action_log` | 管理员操作日志 | 审计 |
| `user_feedback` | 用户反馈表 | 反馈内容 |
| `user_wallet` | 用户钱包表 | 余额与累计消费 |
| `balance_ledger` | 余额流水表 | 充值/消费/分配记录 |
| `admin_user_relation` | 管理员用户归属表 | 用户归属哪个管理员 |
| `invite_link` | 邀请链接表 | 注册邀请码 |
| `visit_log` | 访问日志表 | 网站访问统计 |
