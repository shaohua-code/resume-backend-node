# resume-backend-node API 与数据速查

## 路由前缀

| 前缀 | 文件 | 鉴权 |
|------|------|------|
| `/api/auth` | `routers/auth.js` | 公开 |
| `/api/ai` | `routers/ai.js` | `authRequired` |
| `/api/pdf` | `routers/pdf.js` | `authRequired` |
| `/api/resume` | `routers/resume.js` | `authRequired` |
| `/api/wallet` | `routers/wallet.js` | `authRequired` |
| `/api/admin` | `routers/admin.js` | `authRequired` + `requireAdmin` + permission |
| `/api/upload` | `routers/upload.js` | `authRequired` |
| `/api/feedback` | `routers/feedback.js` | `authRequired` |

## Auth `/api/auth`

| Method | Path | 说明 |
|--------|------|------|
| POST | `/sendCode` | 发送邮箱 OTP |
| POST | `/login` | 验证码登录（首次自动注册） |
| POST | `/register` | 验证码 + 用户名 + 密码 |
| POST | `/loginPassword` | 用户名/邮箱 + 密码 |
| POST | `/refresh` | 刷新 token |
| POST | `/resetPassword` | 发送重置验证码 |
| POST | `/updatePassword` | 验证码 + 新密码 |

登录成功字段：`token`, `refresh_token`, `expires_at`, `email`, `nickname`, `user_id`, `role`, `status`, `permissions`

## Wallet `/api/wallet`（均需 Bearer）

| Method | Path | 说明 |
|--------|------|------|
| GET | `/balance` | 当前用户余额与累计消费 |
| GET | `/ledger` | 流水 `?page=&size=` |

## Resume `/api/resume`（均需 Bearer）

### AI（实际路由在 `/api/ai`、`/api/pdf`，此处为业务归类）

task_type 示例：`resume_generate`, `project_optimize`, `jd_match`, `score`, `pdf_optimize`

### CRUD

| Method | Path | 说明 |
|--------|------|------|
| POST | `/create` | 新建 |
| PUT | `/update/:id` | 更新 |
| POST | `/save` | 兼容（有 id 更新，无 id 创建） |
| GET | `/list` | `?page=&size=` |
| GET | `/detail` | `?resume_id=` |
| DELETE | `/delete` | `?resume_id=` 或 body |
| POST | `/export` | 记录导出（登录即可，无 VIP） |

## Admin `/api/admin`

全局：`authRequired` → `requireAdmin`

| Method | Path | Permission |
|--------|------|------------|
| GET | `/stats` | admin:stats |
| GET | `/dashboard` | admin:stats |
| GET | `/users` | admin:manage_users |
| GET | `/users/:userId` | admin:manage_users |
| PATCH | `/users/:userId` | admin:manage_users |
| POST | `/users/:userId/reset-password` | admin:manage_users |
| POST | `/users/:userId/balance` | admin:wallet |
| GET | `/wallets` | admin:wallet |
| GET | `/ai-calls` | admin:view_ai_calls |
| GET | `/resumes` | admin:view_resumes |
| GET | `/resumes/:id` | admin:view_resumes |
| GET | `/configs` | admin:system_config |
| PUT | `/configs/:key` | admin:system_config |
| GET/POST/PATCH/DELETE | `/announcements` | admin:announcement |
| GET/POST/PATCH/DELETE | `/models` | admin:ai_model |
| GET | `/feedbacks` | admin:view_feedback |

调整额度 Body：`{ amount: 20, remark: '活动赠送' }`（负数仅 SUPER_ADMIN）

## 数据表

| 表 | 关键字段 |
|----|----------|
| user_profile | user_id, email, nickname, role, status |
| user_wallet | user_id, balance, total_consumed |
| balance_ledger | user_id, type, amount, balance_after, ai_call_id |
| resume | id, user_id, title, resume_json, template_id, score |
| export_record | user_id, resume_id |
| ai_call_record | task_type, model, tokens, cost, success |
| system_config | config_key, config_value(jsonb) — 含 `register_gift_amount` |
| announcement | title, content, enabled |
| ai_model | model_key, input/output_price_per_million, enabled |
| admin_action_log | admin_user_id, action, target_type/id |
| user_feedback | content_html, content_md |

迁移：`supabase/migrations/20260709_token_billing.sql`

## 权限（utils/permissions.js）

**角色：** SUPER_ADMIN, ADMIN, USER

**管理：** admin:dashboard, admin:stats, admin:manage_users, admin:manage_admins, admin:view_ai_calls, admin:view_resumes, admin:system_config, admin:announcement, admin:ai_model, admin:wallet, admin:view_feedback

**用户：** user:resume_create, user:resume_edit

**钱包：** wallet:view_self, wallet:grant_users（管理员）, wallet:manage_users（超管）

## AI 计费

1. 调用前 `ensureAiQuota()` → `walletService.ensureSufficientBalance()`
2. 成功后 `recordAiCall()` 写入 `ai_call_record` 并 `deductForAiCall()`
3. 费用按 `utils/ai_cost.js` + `ai_model` 表单价计算
4. 余额不足：`402` + `code: INSUFFICIENT_BALANCE`

## resume_json（AI 输出）

扩展基本信息：`work_years`, `marital_status`, `height`, `weight`, `ethnicity`, `native_place`, `political_status`, `expected_salary`, `custom_fields: [{label,value}]`

教育：`educations: [{school, major, degree, start_date, end_date}]`；扁平 `school/major/education` 与首条同步

规范化：`services/ai/ai.service.js` → `normalizeEducations`, `normalizePdfResume`, `buildResumeContext`

Prompt 字段说明：`services/ai/ai.prompts.js`

## 超级管理员初始化

```sql
UPDATE user_profile SET role = 'SUPER_ADMIN' WHERE email = 'your@email.com';
```
