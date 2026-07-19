# 数据库表中文对照

项目共 **25 张表**，建表脚本见 [`init.sql`](init.sql)。

验证表数量：

```sql
SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';
-- 预期：25
```

---

## 1. 认证模块

### users — 用户账号表

| 项 | 说明 |
|---|---|
| 主键 | `id` (UUID) |
| 核心字段 | `account`（可空、存在时为小写且忽略大小写唯一）、`email`（可空且忽略大小写唯一）、`password_hash`、`password_plain`（仅保留为旧库结构兼容列，初始化脚本清空且运行代码不写入）、`email_verified`、`session_version`、`created_at`、`updated_at` |
| 约束 | `email`、`account` 至少有一项非空；新注册账号使用 `account`，邮箱验证码绑定成功后才写入 `email` |
| 会话撤销 | access token 携带 `session_version`；密码重置递增版本并删除 refresh token，使旧会话立即失效 |
| 关联 | `user_profile.user_id` → `users.id`（CASCADE） |
| 代码路径 | `services/auth/auth.service.js`（直连 `lib/db.js`） |

### otp_codes — 验证码表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `user_id`（绑定邮箱验证码必填）、`email`、`code`、`type`（login/reset/bind_email）、`expires_at`、`used`、`attempt_count` |
| 关联 | `user_id` → `users.id`（CASCADE，可空以兼容历史验证码）；登录与重置按邮箱关联，邮箱绑定同时按用户与邮箱关联 |
| 代码路径 | `services/auth/auth.service.js` |

### refresh_tokens — 刷新令牌表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `user_id`、`token_hash`、`session_version`、`expires_at` |
| 关联 | `user_id` → `users.id`（CASCADE） |
| 轮换规则 | refresh token 一次性原子消费；记录版本必须与 `users.session_version` 相同，否则拒绝轮换 |
| 代码路径 | `lib/jwt.js` |

---

## 2. 用户资料

### user_profile — 用户资料表

| 项 | 说明 |
|---|---|
| 主键 | `user_id` (UUID) |
| 核心字段 | `email`（未绑定时可空）、`nickname`、`role`（SUPER_ADMIN/ADMIN/USER）、`status`（ACTIVE/BANNED） |
| 关联 | `user_id` → `users.id`（CASCADE） |
| 代码路径 | `repositories/user.repository.js`、`services/user_profile_service.js` |

---

## 3. 简历

### resume — 简历表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `user_id`、`title`、`resume_json`、`template_id`、`score`、`client_request_id`（AI 结果首次保存幂等键） |
| 约束 | `(user_id, client_request_id)` 在幂等键非空时唯一；同一用户重试返回既有记录，不重复创建或替换最早简历 |
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
| 核心字段 | `name`、`model_key`（唯一）、`provider`、`model_type`、`api_url`、`api_key_env`、输入/缓存输入/输出单价、`thinking_enabled`、`enabled` |
| 关联 | 按 `model_key` 被计费逻辑引用；被 `ai_task_model.model_id` 引用 |
| 代码路径 | `utils/ai_cost.js`、`services/ai/ai.model.js`、`services/admin/admin.aiModel.service.js` |

### ai_task_model — AI 任务模型映射表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `task_type`（唯一）、`required_model_type`、`model_id`、`thinking_enabled`（NULL=沿用模型；true/false=任务级覆盖） |
| 关联 | `model_id` → `ai_model.id`（RESTRICT） |
| 代码路径 | `services/ai/ai.model.js`、`services/admin/admin.aiModel.service.js` |

### user_ai_task_model — 用户任务模型覆盖表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `user_id`、`task_type`、`model_id`；`UNIQUE(user_id, task_type)` |
| 关联 | `user_id` → `users.id`（CASCADE）；`model_id` → `ai_model.id`（RESTRICT） |
| 说明 | 仅选择管理员已启用模型；需 `user_ai_model_customization.enabled=true`；无覆盖回退 `ai_task_model` |
| 代码路径 | `services/user/userAiConfig.service.js`、`services/ai/ai.model.js` |

### ai_task_prompt — 管理员默认业务提示词

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `task_type`（唯一）、`instruction` |
| 说明 | 仅业务指令；JSON Schema/输出格式永不入库，由代码锁定追加 |
| 代码路径 | `services/user/userAiConfig.service.js`、`services/ai/ai.promptResolve.js` |

### user_ai_task_prompt — 用户业务提示词覆盖

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `user_id`、`task_type`、`instruction`；`UNIQUE(user_id, task_type)` |
| 关联 | `user_id` → `users.id`（CASCADE） |
| 说明 | 需 `user_ai_prompt_customization.enabled=true`；回退管理员 → 代码默认 |
| 代码路径 | `services/user/userAiConfig.service.js`、`services/ai/ai.promptResolve.js` |

---

## 6. 系统配置

### system_config — 系统配置表

| 项 | 说明 |
|---|---|
| 主键 | `config_key` (TEXT) |
| 核心字段 | `config_value`（JSONB）、`description` |
| 常用键 | `register_gift_amount`、`super_admin_total_quota`、`ai_daily_limit`、`user_ai_model_customization`、`user_ai_prompt_customization` |
| 代码路径 | `repositories/config.repository.js` |

### announcement — 公告表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `title`、`content`（Markdown）、`version_label`、`start_at`、`end_at`、`enabled` |
| 说明 | 登录用户 `GET /api/announcements/active` 取时间窗内启用公告；已读存前端 localStorage |
| 代码路径 | `services/announcement/announcement.service.js`、`services/admin/admin.crud.service.js` |

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
| 核心字段 | `balance`、`total_consumed`、`register_gift_granted_at`（首次邮箱验证赠金幂等标记） |
| 关联 | `user_id` → `users.id`（CASCADE） |
| 代码路径 | `repositories/wallet.repository.js`、`services/wallet/wallet.service.js`、`services/auth/auth.service.js`（首次验证赠金） |

### balance_ledger — 余额流水表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `user_id`、`type`、`amount`、`balance_after`、`remark`、`operator_id`、`ai_call_id`、`paid_amount` |
| 流水类型 | `REGISTER_GIFT`、`AI_CONSUME`、`ADMIN_GRANT`、`ADMIN_DEDUCT`、`REFUND` |
| 关联 | `user_id` → `users.id`；`ai_call_id` → `ai_call_record.id` |
| 代码路径 | `repositories/wallet.repository.js`、`services/wallet/wallet.service.js`、`services/auth/auth.service.js`（首次验证赠金） |

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

### admin_recharge_config — 管理员充值二维码配置

| 项 | 说明 |
|---|---|
| 主键 | `admin_id` (UUID) |
| 核心字段 | `payment_qrcode_url`（付款码）、`contact_qrcode_url`（管理员联系二维码） |
| 隔离 | 每个管理员独立一行，互不影响 |
| 代码路径 | `services/admin/admin.recharge.service.js` |

### recharge_request — 充值凭证申请表

| 项 | 说明 |
|---|---|
| 主键 | `id` (BIGSERIAL) |
| 核心字段 | `user_id`、`admin_id`、`proof_url`（支付凭证）、`paid_amount`（实付）、`grant_amount`（实际充值）、`status`（PENDING/APPROVED） |
| 关联 | `user_id` / `admin_id` / `operator_id` → `users.id`；`ledger_id` → `balance_ledger.id` |
| 代码路径 | `services/admin/admin.rechargeRequest.service.js` |

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

## 数据库脚本

| 脚本 | 用途 |
|---|---|
| [`init.sql`](init.sql) | 唯一数据库结构初始化脚本；不保留额外迁移、重置或清理 SQL |

---

## 表名速查

| 英文表名 | 中文名称 | 简要说明 |
|---------|---------|---------|
| `users` | 用户账号表 | 随机账号、可选绑定邮箱、密码哈希、邮箱绑定状态 |
| `otp_codes` | 验证码表 | 登录/重置密码/邮箱绑定 OTP 与错误次数 |
| `refresh_tokens` | 刷新令牌表 | JWT refresh token |
| `user_profile` | 用户资料表 | 昵称、角色、封禁状态 |
| `resume` | 简历表 | 简历 JSON 数据 |
| `export_record` | 导出记录表 | PDF 导出审计 |
| `membership_plan` | 会员套餐表 | 套餐配置（已弱化 VIP） |
| `order_record` | 订单表 | 支付订单 |
| `ai_call_record` | AI 调用记录表 | Token 用量与费用 |
| `ai_model` | AI 模型配置表 | 模型类型、供应商、调用入口、深度思考与 Token 单价 |
| `ai_task_model` | AI 任务模型映射表 | 每个任务当前使用的模型 |
| `user_ai_task_model` | 用户任务模型覆盖 | 用户按任务选择模型 |
| `ai_task_prompt` | 管理员默认提示词 | 业务指令默认 |
| `user_ai_task_prompt` | 用户提示词覆盖 | 用户业务指令 |
| `system_config` | 系统配置表 | 注册赠送额、超管额度池、用户 AI 开关等 |
| `announcement` | 公告表 | 版本公告（时间窗 + Markdown） |
| `admin_action_log` | 管理员操作日志 | 审计 |
| `user_feedback` | 用户反馈表 | 反馈内容 |
| `user_wallet` | 用户钱包表 | 余额与累计消费 |
| `balance_ledger` | 余额流水表 | 充值/消费/分配记录 |
| `admin_user_relation` | 管理员用户归属表 | 用户归属哪个管理员 |
| `invite_link` | 邀请链接表 | 注册邀请码 |
| `admin_recharge_config` | 管理员充值二维码配置 | 付款码与联系二维码 |
| `recharge_request` | 充值凭证申请表 | 用户提交凭证、管理员审核入账 |
| `visit_log` | 访问日志表 | 网站访问统计 |
